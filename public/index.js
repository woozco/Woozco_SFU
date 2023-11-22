const io = require("socket.io-client");
const mediasoupClient = require("mediasoup-client");

const roomName = window.location.pathname.split("/")[2];
require('dotenv').config();

const socket = io("/mediasoup");
const chat = io("http://woozco.aolda.net");

let messages = [];
let clients = [];
let isCam = false;
let isShare = false;
let isMic = false;

socket.on("connection-success", ({ socketId }) => {
  console.log(socketId);
});

let device;
let rtpCapabilities;
let producerTransport;
let consumerTransports = [];
let producer;
let consumer;
let isProducer = false;
let params = {
  // mediasoup params
  encodings: [
    {
      rid: "r0",
      maxBitrate: 100000,
      scalabilityMode: "S3T3",
    },
    {
      rid: "r1",
      maxBitrate: 300000,
      scalabilityMode: "S3T3",
    },
    {
      rid: "r2",
      maxBitrate: 900000,
      scalabilityMode: "S3T3",
    },
  ],
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
  codecOptions: {
    videoGoogleStartBitrate: 1000,
  },
};

const joinRoom = () => {
  socket.emit("joinRoom", { roomName }, (data) => {
    console.log(`Router RTP Capabilities... ${data.rtpCapabilities}`);
    // we assign to local variable and will be used when
    // loading the client Device (see createDevice above)

    rtpCapabilities = data.rtpCapabilities;

    // once we have rtpCapabilities from the Router, create Device
    createDevice();
  });
};

const streamSuccess = (stream, element) => {
  element.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  params = {
    track,
    ...params,
  };

  joinRoom();
};

const audioStreamSuccess = (stream, element) => {
  element.srcObject = stream;
  const track = stream.getAudioTracks()[0];
  params = {
    track,
    ...params,
  };

  joinRoom();
};

const getLocalStream = () => {
  const localVideo = document.getElementById("localVideo");
  console.log(navigator);
  navigator.mediaDevices
    .getUserMedia({
      video: {
        width: {
          min: 640,
          max: 1920,
        },
        height: {
          min: 400,
          max: 1080,
        },
      },
    })
    .then((stream) => streamSuccess(stream, localVideo))
    .catch((error) => {
      console.log(error.message);
    });
};

const getScreenShareStream = () => {
  const shareVideoElement = document.getElementById("shareVideo");
  console.log(navigator.mediaDevices);
  navigator.mediaDevices.getDisplayMedia({
    video: true,
  })
    .then((stream) => streamSuccess(stream, shareVideoElement))
    .catch((error) => {
      console.error("화면 공유 에러:", error);
    });
};

const getAudioStream = () => {
  const shareAudioElement = document.getElementById("audioComponent");
  console.log(navigator);
  navigator.mediaDevices
    .getUserMedia({
      audio : true,
    })
    .then((stream) => audioStreamSuccess(stream, shareAudioElement))
    .catch((error) => {
      console.log(error.message);
    });
};

document.getElementById("screenbtn").addEventListener("click", function () {
  console.log("startShare clicked");
  const btn = document.getElementById("screenbtn");
  if (isShare) {
    closeProducer();
    isShare = false;
    btn.textContent = "화면공유 꺼짐";
  }
  else {
    getScreenShareStream();
    isShare = true;
    btn.textContent = "화면공유 켜짐";
  }
});

document.getElementById("camerabtn").addEventListener("click", function () {
  console.log("startFace clicked");
  const btn = document.getElementById("camerabtn");
  if (isCam) {
    closeProducer();
    isCam = false;
    btn.textContent = "카메라 꺼짐";
  }
  else {
    getLocalStream();
    isCam = true;
    btn.textContent = "카메라 켜짐";
  }
});

document.getElementById("micbtn").addEventListener("click", function () {
  console.log("chat clicked");
  const btn = document.getElementById("micbtn");
  if (isMic) {
    const audioElement = document.getElementById("audioComponent");
    streamSuccess(null, audioElement);
    isMic = false;
    btn.textContent = "마이크 꺼짐";
  }
  else {
    getAudioStream();
    isMic = true;
    btn.textContent = "마이크 켜짐";
  }
});

document.getElementById("chatbtn").addEventListener("click", function () {
  console.log("chat clicked");
});

const closeProducer = async () => {
  try {
    if (producer) {
      await producer.close();
      socket.emit("producerclose");
      const videoElementId = producer.id;
      const videoElement = document.getElementById(videoElementId);
      if (videoElement) {
        videoElement.parentNode.removeChild(videoElement);
      }
      producer = null;
    }
  } catch (error) {
    console.error('Error closing producer:', error);
  }
};

// A device is an endpoint connecting to a Router on the
// server side to send/recive media
const createDevice = async () => {
  try {
    device = new mediasoupClient.Device();

    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#device-load
    // Loads the device with RTP capabilities of the Router (server side)
    await device.load({
      // see getRtpCapabilities() below
      routerRtpCapabilities: rtpCapabilities,
    });

    console.log("Device RTP Capabilities", device.rtpCapabilities);

    // once the device loads, create transport
    createSendTransport();
  } catch (error) {
    console.log(error);
    if (error.name === "UnsupportedError")
      console.warn("browser not supported");
  }
};

const createSendTransport = () => {
  // see server's socket.on('createWebRtcTransport', sender?, ...)
  // this is a call from Producer, so sender = true
  socket.emit("createWebRtcTransport", { consumer : false }, ({ params }) => {
    // The server sends back params needed
    // to create Send Transport on the client side
    if (params.error) {
      console.log(params.error);
      return;
    }

    console.log(params);

    // creates a new WebRTC Transport to send media
    // based on the server's producer transport params
    // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
    producerTransport = device.createSendTransport(params);

    // https://mediasoup.org/documentation/v3/communication-between-client-and-server/#producing-media
    // this event is raised when a first call to transport.produce() is made
    // see connectSendTransport() below
    producerTransport.on(
      "connect",
      async ({ dtlsParameters }, callback, errback) => {
        try {
          // Signal local DTLS parameters to the server side transport
          // see server's socket.on('transport-connect', ...)
          await socket.emit("transport-connect", {
            dtlsParameters,
          });

          // Tell the transport that parameters were transmitted.
          callback();
        } catch (error) {
          errback(error);
        }
      }
    );

    producerTransport.on(
      "produce",
      async (parameters, callback, errback) => {
        console.log(parameters);

        try {
          // tell the server to create a Producer
          // with the following parameters and produce
          // and expect back a server side producer id
          // see server's socket.on('transport-produce', ...)
          await socket.emit(
            "transport-produce",
            {
              kind: parameters.kind,
              rtpParameters: parameters.rtpParameters,
              appData: parameters.appData,
            },
            ({ id, producersExist }) => {
              // Tell the transport that parameters were transmitted and provide it with the
              // server side producer's id.
              callback({ id });

              // if producers exist, then join room
              if (producersExist) getProducers();
            }
          );
        } catch (error) {
          errback(error);
        }
      }
    );
      
    connectSendTransport();
  });
};

const connectSendTransport = async () => {
  // we now call produce() to instruct the producer transport
  // to send media to the Router
  // https://mediasoup.org/documentation/v3/mediasoup-client/api/#transport-produce
  // this action will trigger the 'connect' and 'produce' events above
  producer = await producerTransport.produce(params);

  producer.on("trackended", () => {
    console.log("track ended");
  });

  producer.on("transportclose", () => {
    console.log("transport ended");
  });
};

const signalNewConsumerTransport = async (remoteProducerId) => {
  await socket.emit(
    "createWebRtcTransport",
    { consumer: true },
    ({ params }) => {
      // The server sends back params needed
      // to create Send Transport on the client side
      if (params.error) {
        console.log(params.error);
        return;
      }
      console.log(`PARAMS... ${params}`);

      let consumerTransport;
      try {
        consumerTransport = device.createRecvTransport(params);
      } catch (error) {
        // exceptions:
        // {InvalidStateError} if not loaded
        // {TypeError} if wrong arguments.
        console.log(error);
        return;
      }

      consumerTransport.on(
        "connect",
        async ({ dtlsParameters }, callback, errback) => {
          try {
            // Signal local DTLS parameters to the server side transport
            // see server's socket.on('transport-recv-connect', ...)
            await socket.emit("transport-recv-connect", {
              dtlsParameters,
              serverConsumerTransportId: params.id,
            });

            // Tell the transport that parameters were transmitted.
            callback();
          } catch (error) {
            // Tell the transport that something was wrong
            errback(error);
          }
        }
      );

      connectRecvTransport(
        consumerTransport,
        remoteProducerId,
        params.id
      );
    }
  );
};

// server informs the client of a new producer just joined
socket.on("new-producer", ({ producerId }) =>
  signalNewConsumerTransport(producerId)
);

const getProducers = () => {
  socket.emit("getProducers", (producerIds) => {
    console.log(producerIds);
    // for each of the producer create a consumer
    // producerIds.forEach(id => signalNewConsumerTransport(id))
    producerIds.forEach(signalNewConsumerTransport);
  });
};

const connectRecvTransport = async (
  consumerTransport,
  remoteProducerId,
  serverConsumerTransportId
) => {
  // for consumer, we need to tell the server first
  // to create a consumer based on the rtpCapabilities and consume
  // if the router can consume, it will send back a set of params as below
  await socket.emit(
    "consume",
    {
      rtpCapabilities: device.rtpCapabilities,
      remoteProducerId,
      serverConsumerTransportId,
    },
    async ({ params }) => {
      if (params.error) {
        console.log("Cannot Consume");
        return;
      }

      console.log(`Consumer Params ${params}`);
      // then consume with the local consumer transport
      // which creates a consumer
      const consumer = await consumerTransport.consume({
        id: params.id,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
      });

      consumerTransports = [
        ...consumerTransports,
        {
          consumerTransport,
          serverConsumerTransportId: params.id,
          producerId: remoteProducerId,
          consumer,
        },
      ];

      // create a new div element for the new consumer media
      // and append to the video container
      const newElem = document.createElement("div");
      newElem.setAttribute("id", `td-${remoteProducerId}`);
      newElem.setAttribute("class", "remoteVideo");
      newElem.innerHTML =
        '<video id="' +
        remoteProducerId +
        '" autoplay class="video" ></video>';
      videoContainer.appendChild(newElem);

      // destructure and retrieve the video track from the producer
      const { track } = consumer;

      document.getElementById(remoteProducerId).srcObject =
        new MediaStream([track]);

      // the server consumer started with media paused
      // so we need to inform the server to resume
      socket.emit("consumer-resume", {
        serverConsumerId: params.serverConsumerId,
      });
    }
  );
};

socket.on("producer-closed", ({ remoteProducerId }) => {
  // server notification is received when a producer is closed
  // we need to close the client-side consumer and associated transport
  const producerToClose = consumerTransports.find(
    (transportData) => transportData.producerId === remoteProducerId
  );
  producerToClose.consumerTransport.close();
  producerToClose.consumer.close();

  // remove the consumer transport from the list
  consumerTransports = consumerTransports.filter(
    (transportData) => transportData.producerId !== remoteProducerId
  );

  // remove the video div element
  videoContainer.removeChild(
    document.getElementById(`td-${remoteProducerId}`)
  );
});

// Chat
document.getElementById("sendMsg").addEventListener("click", function () {
  handleSendMessage();
});

const handleSendMessage = () => {
  const messageContent = document.getElementById("msg");
  if (messageContent.value.trim() === "") return;
  chat.emit("sendMessage", {
    room: roomName,
    content: messageContent.value,
  });
  messageContent.value = "";
};

const displayChatList = () => {
  const container = document.getElementById("chatList");

  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  messages.forEach((item) => {
    const listItem = document.createElement("div");
    listItem.textContent = item.senderId + " : " + item.content;
    container.appendChild(listItem);
  });
}

const displayClientList = () => {
  const container = document.getElementById("clientList");

  clients.forEach((item) => {
    const listItem = document.createElement("div");
    listItem.textContent = item.senderId + " : " + item.content;
    container.appendChild(listItem);
  });
}

const receiveRoomMessagePromise = () => {
  return new Promise((resolve) => {
    chat.once("roomMessages", (data) => {
      if (Array.isArray(data)) {
        resolve(data);
      } else {
        console.error("Received non-array data for messages:", msgs);
        resolve([]);
      }
    });
  })
}

const fetchPreviousMessages = async () => {
  try {
    chat.emit("getMessages", roomName);
    const previousMessages = await receiveRoomMessagePromise();
    if (!previousMessages.length == 0) {
      messages = previousMessages;
      displayChatList();
    }
  } catch (error) {
    console.error("Error fetching previous messages:", error);
  }
};

const handleNewMessage = ({ senderId, content }) => {
  const message = { senderId, content };
  messages = [...messages, message];
  console.log(messages);
  displayChatList();
};

const handleClientsList = (clientIds) => {
  clients = [...clients, clientIds];
  displayClientList();
};

window.onload = function () {
  chat.emit("joinRoom", roomName);
  chat.emit("getClientsInRoom", roomName);

  fetchPreviousMessages();

  chat.on("newMessage", handleNewMessage);

  chat.on("clientsList", handleClientsList);

  return () => {
    socket.off("newMessage", handleNewMessage);
    socket.off("clientsList", handleClientsList);
  };
};