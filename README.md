# Jmeter Runner
A small HTTP server to simplify running jmeter tests, follow progress and check the results.

## Docker
The server can be run as a Docker container, after creating a Docker image for it. The Docker container will keep running until stopped.

To create a Docker image, run the following command:
```bash
docker build --tag vsds/jmeter-runner .
```
To run the server, you can use:
```bash
mkdir ./tests
chmod 0777 ./tests
docker compose up
```
