# Jmeter Runner
A small HTTP server to simplify running jmeter tests, follow progress and check the results.

The server needs only minimal configuration. You need to provide a location to store the tests and their results and you need to configure the base URL of the HTTP server.

## Docker
The server can be run as a Docker container, after creating a Docker image for it. The Docker container will keep running until stopped.

To create a Docker image, run the following command:
```bash
docker build --tag vsds/jmeter-runner .
```
> **Note** that we also have pre-built docker images available [here](https://github.com/Informatievlaanderen/jmeter-runner/pkgs/container/jmeter-runner).

To run the jmeter runner Docker image mapped on port 9000 and storing the test data on the host system, you can use:
```bash
docker run -d -p 9000:80 -v ./tests:/home/node/jmeter-runner/tests:rw -v ./temp:/home/node/jmeter-runner/temp:rw -e BASE_URL=http://localhost:9000 vsds/jmeter-runner
```

The Docker run command will return a container ID (e.g. `e2267325aad52663fef226aad49e729acc92f2f3936bec47a354d015e47c33d6`), which you need to stop the container.

Alternatively you can run `docker ps` to retrieve the (short version of the) container ID.
```
CONTAINER ID   IMAGE                COMMAND                  CREATED          STATUS          PORTS                                   NAMES
e2267325aad5   vsds/jmeter-runner   "/usr/bin/dumb-init …"   28 seconds ago   Up 27 seconds   0.0.0.0:9000->80/tcp, :::9000->80/tcp   brave_saha
```
To stop the container, you need to call the stop command with the (long or short) container ID, e.g. `docker stop e2267325aad5`

## Docker compose
For your convenience a [Docker compose file](./docker-compose.yml) is provided containing the jmeter runner, and a [.env](./.env) file with environment variables used for building and running the containers. Some variables may need tuning for your use case. Then you can run the following command to build and run the Docker containers:

```bash
docker compose up
```

## Build
The jmeter runner is implemented as a [Node.js](https://nodejs.org/en/) application.
You need to run the following commands to build it:
```bash
npm i
npm run build
```

## Run
The jmeter runner uses the file system as permanent storage to allow for keeping the tests and results between restarts, so before running the jmeter runner, make sure you have created a directory and have it the correct permissions, e.g.:
```bash
mkdir -p ./tests
chmod 0777 ./tests
mkdir -p ./temp
chmod 0777 ./temp
```

The jmeter runner takes the following command line arguments:
* `--test-folder-base` the test directory to store all test related (result) data, defaults to `./tests`
* `--temp-folder-base` the temp directory to store test run data, defaults to `./temp`
* `--base-url` sets the 'external' base URL, used to refer to a test status and the test results, default to the host and port (using scheme HTTP, e.g. http://localhost:80)
* `--silent=<true|false>` prevents any console debug output if true, defaults to false (not silent, logging all debug info)
* `--port=<port-number>` allows to set the port, defaults to `80`
* `--host=<host-name>` allows to set the hostname, defaults to `localhost`
* `--refresh-time` allows to change the status and overview page refresh time in seconds, defaults to `30`
* `--run-test-api-key` the API key to protect the run test endpoint, defaults to no API key checking
* `--check-test-api-key` the API key to protect the test status and results endpoints, defaults to no API key checking
* `--delete-test-api-key` the API key to protect the delete test endpoint, defaults to no API key checking
* `--custom-labels` collection of custom labels (separated by a blank) for prometheus, defaults to ``

> **Note** that you can pass these API keys using the header `x-api-key`.

You can run the jmeter runner with the following command after building it:
```bash
node ./dist/server.js --port=9000
```
This results in:
```
Arguments:  { _: [], port: 9000 }
Test runner listening at http://127.0.0.1:9000
```

## Usage
The jmeter runner accepts the following REST calls.

### `GET /test` -- Get Test Runs Overview
Returns a HTML page displaying the queued tests (if any), the currently running test (if any) and the completed test runs per test and per category, e.g.
```bash
curl http://localhost:9000/test
```

> **Note** that you can cancel a running test on this page. Also see [Cancel a Test Run](#delete-testtest-run-idconfirmtrue----cancel-test-run-or-remove-test-and-results).


> **Note** that after cancelling a test you may need to cleanup your system being tested and therefore the jmeter runner will pause running (queued) tests until you [Resume the Runner](#post-statusresume----resume-the-runner-if-paused).

### `POST /test` -- Start Test Run
> **Note** that before running the jmeter [example test](./example.jmx) you will need to install an HTTP server (once) and serve the test page (in a separate bash shell):
```bash
npm install --global http-server
http-server ./example -p 8080
```
> **Note** that you may need to run the global NPM install as super user (`sudo`).

Initiates a jmeter test (mime-type: `application/xml`) and returns the test ID as well as a URL to the status page and the results page, e.g.
```bash
curl -X POST http://localhost:9000/test -H "Content-Type: application/xml" --data "@./example.jmx"
```
returns something like:
```json
{"id":"c47a3487-2f9f-433c-ab5a-82b196fff7e1"}
```

> **Note** that the results page will only exist after the test has completed and the status page allows you to follow the test progress and is automatically refreshed (see `--refresh-time`).

> **Note** that the jmeter runner extracts the test name from the jmeter test and uses it to group together all the test runs for the same test name. In addition, you can pass a category to allow grouping tests according to this category by appending a category name in the query string. E.g.:
```bash
curl -X POST http://localhost:9000/test?category=Examples -H "Content-Type: application/xml" --data "@./example.jmx"
```

### `GET /test/<test-run-id>` -- Get Test Run Status
Returns a HTML page (auto-refreshed) with the status for the test run with the given ID.
```bash
curl http://localhost:9000/test/c47a3487-2f9f-433c-ab5a-82b196fff7e1
```
> **Note** that the jmeter runner only displays the last 1000 lines by default. If you need to see more or less lines you can specify a `limit` as a query parameter. E.g.:
```bash
curl http://localhost:9000/test/c47a3487-2f9f-433c-ab5a-82b196fff7e1?limit=100
```
or if you want to display everything, you need to add a zero limit:
```bash
curl http://localhost:9000/test/c47a3487-2f9f-433c-ab5a-82b196fff7e1?limit=0
```

> **Note** that the jmeter runner will automatically redirect if the test is done to either the results (test completed) or the `jmeter.log` file (test cancelled).

### `GET /test/<test-run-id>/results` -- Get Test Run Results
Returns a HTML page with the results for the test run with the given ID.
```bash
curl "http://localhost:9000/test/c47a3487-2f9f-433c-ab5a-82b196fff7e1/results"
```
> **Note** that you can also get the `jmeter.log` and related files (`test.jmx`, `report.jtl`, etc.), e.g.
```bash
curl "http://localhost:9000/test/c47a3487-2f9f-433c-ab5a-82b196fff7e1/jmeter.log"
```

### `DELETE /test/<test-run-id>[?confirm=true]` -- Cancel Test Run or Remove Test And Results
If confirmed (`?confirm=true`), removes the test run with the given ID and its related data including results, so use with caution. If a test is running it is first cancelled. E.g.:
```bash
curl -X DELETE http://localhost:9000/test/c47a3487-2f9f-433c-ab5a-82b196fff7e1?confirm=true
```

> **Note** that you can also cancel a running test by clicking the `Cancel` button on [the test overview page](#get-test----get-test-runs-overview) next to the running test.

If not confirmed, a running test is simply cancelled. E.g.:
```bash
curl -X DELETE http://localhost:9000/test/c47a3487-2f9f-433c-ab5a-82b196fff7e1
```
### `DELETE /test[?confirm=true]` -- Cancel All Test Runs or Delete All Tests
If confirmed (`?confirm=true`), removes all tests and their related data including results, so use with extreme caution. All running tests are cancelled before deletion. E.g.:
```bash
curl -X DELETE http://localhost:9000/test?confirm=true
```

If not confirmed, all running tests are simply cancelled. E.g.
```bash
curl -X DELETE http://localhost:9000/test
```

### `GET /prometheus` -- Get Metrics
Exposes the metrics using [Prometheus](https://prometheus.io/) format.

### `POST /status/resume` -- Resume the Runner if Paused
When you [Cancel a Test](#delete-testtest-run-idconfirmtrue----cancel-test-run-or-remove-test-and-results) you need to verify and if needed clean the state of your system under test (SUT). Therefore the jmeter runner will pause processing new tests by queue new test requests until you confirm that it should resume. E.g. :
```bash
curl -X POST http://localhost:9000/status/resume
```
