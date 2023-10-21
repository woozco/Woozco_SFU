# Node.js v16 버전을 베이스 이미지로 사용합니다.
FROM node:16

# 작업 디렉토리를 설정합니다.
WORKDIR /usr/src/app

# mediasoup을 실행하기 위해 필요한 시스템 의존성을 설치합니다.
RUN apt-get update && apt-get install -y \
    gcc-8 g++-8 python3 python3-pip make

# node-gyp를 설치합니다. (일부 native 의존성을 빌드하는 데 필요)
RUN npm install -g node-gyp

# package.json와 package-lock.json 파일을 복사하여 의존성을 설치합니다.
COPY package*.json ./

# 프로젝트 의존성을 설치합니다.
RUN npm install

# 애플리케이션 소스를 복사합니다.
COPY . .

# 애플리케이션을 실행하기 위한 명령어를 설정합니다.
CMD [ "npm", "start" ]

# 애플리케이션이 사용하는 포트를 노출시킵니다 (애플리케이션의 설정에 따라 수정이 필요할 수 있습니다).
EXPOSE 3000
