# build environment
FROM node:22-bullseye-slim AS builder
# fix vulnerabilities
ARG NPM_TAG=11.0.0
RUN npm install -g npm@${NPM_TAG}
# build it
WORKDIR /build
COPY . .
RUN npm ci
RUN npm run build

# run environment
FROM node:22.9.0-bullseye-slim
# fix vulnerabilities
# note: trivy insists this to be on the same RUN line
RUN apt-get -y update && apt-get -y upgrade
RUN apt-get -y install apt-utils wget
# install signal-handler wrapper
RUN apt-get -y install dumb-init
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
# install package manager
RUN npm install -g npm@${NPM_TAG}
# install jmeter-runner
WORKDIR /home/node
RUN mkdir -p jmeter-runner/tests
RUN mkdir -p jmeter-runner/temp
COPY --chown=node:node --from=builder /build/package*.json jmeter-runner/
COPY --chown=node:node --from=builder /build/dist/*.js jmeter-runner/
COPY --chown=node:node --from=builder /build/*.html jmeter-runner/
RUN cd ./jmeter-runner && npm ci --omit=dev
ENV PORT=
ENV TEST_FOLDER_BASE=
ENV TEMP_FOLDER_BASE=
ENV SILENT=
ENV REFRESH_TIME=
ENV RUN_TEST_API_KEY=
ENV CHECK_TEST_API_KEY=
ENV DELETE_TEST_API_KEY=
ENV CUSTOM_LABELS=
ENV NODE_ENV=production
EXPOSE 80
# install java runtime
ARG JAVA_TAG=17
RUN apt-get -y install openjdk-${JAVA_TAG}-jre && apt-get clean
# install Apache jmeter
ARG JMETER_TAG=5.6.3
RUN wget https://dlcdn.apache.org/jmeter/binaries/apache-jmeter-${JMETER_TAG}.tgz
RUN tar -xvzf apache-jmeter-${JMETER_TAG}.tgz && rm apache-jmeter-${JMETER_TAG}.tgz
RUN ln -s apache-jmeter-${JMETER_TAG} apache-jmeter
ENV JMETER_HOME=/home/node/apache-jmeter
ENV PATH=${JMETER_HOME}/bin:$PATH
# set jmeter temp folder for report generation
RUN mkdir /tmp/jmeter
RUN chmod 0777 /tmp/jmeter
RUN chown node:node /tmp/jmeter
RUN echo "# temp folder for report generation" >> /home/node/apache-jmeter/bin/user.properties
RUN echo "jmeter.reportgenerator.temp_dir=/tmp/jmeter" >> /home/node/apache-jmeter/bin/user.properties
# run as node
RUN chown node:node -R /home/node/*
WORKDIR /home/node/jmeter-runner
USER node
CMD ["sh", "-c", "node ./server.js --host=0.0.0.0 --port=${PORT} --test-folder-base=${TEST_FOLDER_BASE} --temp-folder-base=${TEMP_FOLDER_BASE} --silent=${SILENT} --refresh-time=${REFRESH_TIME} --run-test-api-key=${RUN_TEST_API_KEY} --check-test-api-key=${CHECK_TEST_API_KEY} --delete-test-api-key=${DELETE_TEST_API_KEY} --custom-labels=\"${CUSTOM_LABELS}\""]
