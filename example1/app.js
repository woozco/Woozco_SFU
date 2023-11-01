import express from "express";
import cors from "cors";
const app = express();
import { createServer } from "https";
import { Server } from "socket.io";

import https from "httpolyglot";
import fs from "fs";
import path from "path";
const __dirname = path.resolve();

import mediasoup from "mediasoup";

app.use(cors({
    origin: '*',
    methods: ["GET", "POST"],
}));

app.get("*", (req, res, next) => {
    const path = "/sfu/";

    if (req.path.indexOf(path) == 0 && req.path.length > path.length)
        return next();

    res.send(
        `You need to specify a room name in the path e.g. 'https://127.0.0.1/sfu/room'`
    );
});

app.use("/sfu/:room", express.static(path.join(__dirname, "public")));

// SSL cert for HTTPS access
const options = {
    key: fs.readFileSync("./server/ssl/key.pem", "utf-8"),
    cert: fs.readFileSync("./server/ssl/cert.pem", "utf-8"),
};

const httpsServer = https.createServer(options, app);
httpsServer.listen(3002, () => {
    console.log("listening on port: " + 3002);
});

const server = createServer();
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
});

// socket.io namespace (could represent a room?)
const connections = io.of("/mediasoup");

let worker;
let rooms = {}; // { roomName1: { Router, rooms: [ sicketId1, ... ] }, ...}
let peers = {}; // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}
let transports = []; // [ { socketId1, roomName1, transport, consumer }, ... ]
let producers = []; // [ { socketId1, roomName1, producer, }, ... ]
let consumers = []; // [ { socketId1, roomName1, consumer, }, ... ]

const createWorker = async () => {
    worker = await mediasoup.createWorker({
        rtcMinPort: 2000,
        rtcMaxPort: 3020,
    });
    console.log(`worker pid ${worker.pid}`);

    worker.on("died", (error) => {
        // This implies something serious happened, so kill the application
        console.error("mediasoup worker has died");
        setTimeout(() => process.exit(1), 2000); // exit in 2 seconds
    });

    return worker;
};

// We create a Worker as soon as our application starts
worker = createWorker();

const mediaCodecs = [
    {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
    },
    {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {
            "x-google-start-bitrate": 1000,
        },
    },
];

connections.on("connection", async (socket) => {
    console.log(socket.id);
    socket.emit("connection-success", {
        socketId: socket.id,
    });

    const removeItems = (items, socketId, type) => {
        items.forEach((item) => {
            if (item.socketId === socket.id) {
                item[type].close();
            }
        });
        items = items.filter((item) => item.socketId !== socket.id);

        return items;
    };

    socket.on("disconnect", () => {
        console.log("peer disconnected");
        consumers = removeItems(consumers, socket.id, "consumer");
        producers = removeItems(producers, socket.id, "producer");
        transports = removeItems(transports, socket.id, "transport");

        const { roomName } = peers[socket.id];
        delete peers[socket.id];

        rooms[roomName] = {
            router: rooms[roomName].router,
            peers: rooms[roomName].peers.filter(
                (socketId) => socketId !== socket.id
            ),
        };
    });

    socket.on("joinRoom", async ({ roomName }, callback) => {
        const router1 = await createRoom(roomName, socket.id);

        peers[socket.id] = {
            socket,
            roomName,
            transports: [],
            producers: [],
            consumers: [],
            peerDetails: {
                name: "",
                isAdmin: false, // Is this Peer the Admin?
            },
        };

        // get Router RTP Capabilities
        const rtpCapabilities = router1.rtpCapabilities;

        // call callback from the client and send back the rtpCapabilities
        callback({ rtpCapabilities });
    });

    const createRoom = async (roomName, socketId) => {
        let router1;
        let peers = [];
        if (rooms[roomName]) {
            router1 = rooms[roomName].router;
            peers = rooms[roomName].peers || [];
        } else {
            router1 = await worker.createRouter({ mediaCodecs });
        }

        console.log(`Router ID: ${router1.id}`, peers.length);

        rooms[roomName] = {
            router: router1,
            peers: [...peers, socketId],
        };

        return router1;
    };

    socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
        // get Room Name from Peer's properties
        const roomName = peers[socket.id].roomName;

        // get Router (Room) object this peer is in based on RoomName
        const router = rooms[roomName].router;

        createWebRtcTransport(router).then(
            (transport) => {
                callback({
                    params: {
                        id: transport.id,
                        iceParameters: transport.iceParameters,
                        iceCandidates: transport.iceCandidates,
                        dtlsParameters: transport.dtlsParameters,
                    },
                });

                // add transport to Peer's properties
                addTransport(transport, roomName, consumer);
            },
            (error) => {
                console.log(error);
            }
        );
    });

    const addTransport = (transport, roomName, consumer) => {
        transports = [
            ...transports,
            { socketId: socket.id, transport, roomName, consumer },
        ];

        peers[socket.id] = {
            ...peers[socket.id],
            transports: [...peers[socket.id].transports, transport.id],
        };
    };

    const addProducer = (producer, roomName) => {
        producers = [...producers, { socketId: socket.id, producer, roomName }];

        peers[socket.id] = {
            ...peers[socket.id],
            producers: [...peers[socket.id].producers, producer.id],
        };
    };

    const addConsumer = (consumer, roomName) => {
        consumers = [...consumers, { socketId: socket.id, consumer, roomName }];

        peers[socket.id] = {
            ...peers[socket.id],
            consumers: [...peers[socket.id].consumers, consumer.id],
        };
    };

    socket.on("getProducers", (callback) => {
        const { roomName } = peers[socket.id];

        let producerList = [];
        producers.forEach((producerData) => {
            if (
                producerData.socketId !== socket.id &&
                producerData.roomName === roomName
            ) {
                producerList = [...producerList, producerData.producer.id];
            }
        });

        // return the producer list back to the client
        callback(producerList);
    });

    const informConsumers = (roomName, socketId, id) => {
        console.log(`just joined, id ${id} ${roomName}, ${socketId}`);
        producers.forEach((producerData) => {
            if (
                producerData.socketId !== socketId &&
                producerData.roomName === roomName
            ) {
                const producerSocket = peers[producerData.socketId].socket;
                // use socket to send producer id to producer
                producerSocket.emit("new-producer", { producerId: id });
            }
        });
    };

    const getTransport = (socketId) => {
        const [producerTransport] = transports.filter(
            (transport) =>
                transport.socketId === socketId && !transport.consumer
        );
        return producerTransport.transport;
    };

    // see client's socket.emit('transport-connect', ...)
    socket.on("transport-connect", ({ dtlsParameters }) => {
        console.log("DTLS PARAMS... ", { dtlsParameters });

        getTransport(socket.id).connect({ dtlsParameters });
    });

    // see client's socket.emit('transport-produce', ...)
    socket.on(
        "transport-produce",
        async ({ kind, rtpParameters, appData }, callback) => {
            // call produce based on the prameters from the client
            const producer = await getTransport(socket.id).produce({
                kind,
                rtpParameters,
            });

            // add producer to the producers array
            const { roomName } = peers[socket.id];

            addProducer(producer, roomName);

            informConsumers(roomName, socket.id, producer.id);

            console.log("Producer ID: ", producer.id, producer.kind);

            producer.on("transportclose", () => {
                console.log("transport for this producer closed ");
                producer.close();
            });

            // Send back to the client the Producer's id
            callback({
                id: producer.id,
                producersExist: producers.length > 1 ? true : false,
            });
        }
    );

    // see client's socket.emit('transport-recv-connect', ...)
    socket.on(
        "transport-recv-connect",
        async ({ dtlsParameters, serverConsumerTransportId }) => {
            console.log(`DTLS PARAMS: ${dtlsParameters}`);
            const consumerTransport = transports.find(
                (transportData) =>
                    transportData.consumer &&
                    transportData.transport.id == serverConsumerTransportId
            ).transport;
            await consumerTransport.connect({ dtlsParameters });
        }
    );

    socket.on(
        "consume",
        async (
            { rtpCapabilities, remoteProducerId, serverConsumerTransportId },
            callback
        ) => {
            try {
                const { roomName } = peers[socket.id];
                const router = rooms[roomName].router;
                let consumerTransport = transports.find(
                    (transportData) =>
                        transportData.consumer &&
                        transportData.transport.id == serverConsumerTransportId
                ).transport;

                // check if the router can consume the specified producer
                if (
                    router.canConsume({
                        producerId: remoteProducerId,
                        rtpCapabilities,
                    })
                ) {
                    // transport can now consume and return a consumer
                    const consumer = await consumerTransport.consume({
                        producerId: remoteProducerId,
                        rtpCapabilities,
                        paused: true,
                    });

                    consumer.on("transportclose", () => {
                        console.log("transport close from consumer");
                    });

                    consumer.on("producerclose", () => {
                        console.log("producer of consumer closed");
                        socket.emit("producer-closed", { remoteProducerId });

                        consumerTransport.close([]);
                        transports = transports.filter(
                            (transportData) =>
                                transportData.transport.id !==
                                consumerTransport.id
                        );
                        consumer.close();
                        consumers = consumers.filter(
                            (consumerData) =>
                                consumerData.consumer.id !== consumer.id
                        );
                    });

                    addConsumer(consumer, roomName);

                    // from the consumer extract the following params
                    // to send back to the Client
                    const params = {
                        id: consumer.id,
                        producerId: remoteProducerId,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                        serverConsumerId: consumer.id,
                    };

                    // send the parameters to the client
                    callback({ params });
                }
            } catch (error) {
                console.log(error.message);
                callback({
                    params: {
                        error: error,
                    },
                });
            }
        }
    );

    socket.on("consumer-resume", async ({ serverConsumerId }) => {
        console.log("consumer resume");
        const { consumer } = consumers.find(
            (consumerData) => consumerData.consumer.id === serverConsumerId
        );
        await consumer.resume();
    });
});

const createWebRtcTransport = async (router) => {
    return new Promise(async (resolve, reject) => {
        try {
            const webRtcTransport_options = {
                listenIps: [
                    {
                        ip: '172.31.1.40', // replace with relevant IP address
                        announcedIp: '3.39.252.90', // 여기에 대해서 해당 컴퓨팅 환경에 대해
                    }
                ],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
                initialAvailableOutgoingBitrate: 1000000, // e.g., 1mbps
                iceServers: [
                    {
                        urls: ["stun:stun.l.google.com:19302"],
                    },
                    {
                        urls: ["turn:aolda-dev.net"],
                        username: "woozco",
                        credential: "woozco",
                    },
                ],
            }


            let transport = await router.createWebRtcTransport(
                webRtcTransport_options
            );
            console.log(`transport id: ${transport.id}`);

            transport.on("dtlsstatechange", (dtlsState) => {
                if (dtlsState === "closed") {
                    transport.close();
                }
            });

            transport.on("close", () => {
                console.log("transport closed");
            });

            resolve(transport);
        } catch (error) {
            reject(error);
        }
    });
};
