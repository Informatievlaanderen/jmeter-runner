# build environment
FROM node:20-bullseye-slim AS builder
# fix vulnerabilities
ARG NPM_TAG=9.9.2
RUN npm install -g npm@${NPM_TAG}
# build it
WORKDIR /build
COPY . .
RUN npm ci
RUN npm run build

# run environment
FROM node:20.11.0-bullseye-slim
# fix vulnerabilities
# note: trivy insists this to be on the same RUN line
RUN apt-get -y update && apt-get -y upgrade
RUN apt-get -y install apt-utils wget
# setup to run as less-privileged user
WORKDIR /home/node/jmeter-runner
COPY --chown=node:node --from=builder /build/package*.json ./
COPY --chown=node:node --from=builder /build/dist/*.js ./
# env vars
ENV BASE_URL=
ENV PORT=
ENV TEST_FOLDER_BASE=
ENV SILENT=
ENV MAX_RUNNING=
ENV REFRESH_TIME=
ENV RUN_TEST_API_KEY=
ENV CHECK_TEST_API_KEY=
ENV DELETE_TEST_API_KEY=
# install signal-handler wrapper
RUN apt-get -y install dumb-init
# set start command
EXPOSE 80
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
# fix vulnerabilities
RUN npm install -g npm@${NPM_TAG}
# install dependancies
ENV NODE_ENV production
RUN npm ci --omit=dev
# install java
RUN apt-get -y install openjdk-11-jdk-headless
# install jmeter
ARG JMETER_TAG=5.6.3
RUN wget https://dlcdn.apache.org/jmeter/binaries/apache-jmeter-${JMETER_TAG}.tgz
RUN tar -xvzf apache-jmeter-${JMETER_TAG}.tgz
RUN mv apache-jmeter-${JMETER_TAG} apache-jmeter
ENV JMETER_HOME=/home/node/jmeter-runner/apache-jmeter
ENV PATH=${JMETER_HOME}/bin:$PATH
# create default tests folder
RUN mkdir ./tests
RUN chown node ./tests
# run as node
USER node
CMD ["sh", "-c", "node ./server.js --host=0.0.0.0 --port=${PORT} --base-url=${BASE_URL} --test-folder-base=${TEST_FOLDER_BASE} --silent=${SILENT} --max-running=${MAX_RUNNING} --refresh-time=${REFRESH_TIME} --run-test-api-key=${RUN_TEST_API_KEY} --check-test-api-key=${CHECK_TEST_API_KEY} --delete-test-api-key=${DELETE_TEST_API_KEY}"]
