import fastify from 'fastify'
import fastifyStatic from '@fastify/static';
import minimist from 'minimist'
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as cp from 'node:child_process';

interface TestRun {
  id: string;
  timestamp: string;
  stdout: string;
  stderr: string;
  done: boolean;
  code: number | null;
}

interface TestRunDatabase {
  [key: string]: TestRun
}

const _database: TestRunDatabase = {};
const megabyte = 1048576;
const server = fastify({ bodyLimit: 10 * megabyte });

const args = minimist(process.argv.slice(2));
const silent: boolean = (/true/i).test(args['silent']);
if (!silent) {
  console.debug("Arguments: ", args);
}

const port = args['port'] || 9009;
const host = args['host'] || 'localhost';
const baseUrl = args['base-url'] || `http://${host}:${port}`;

const maxRunning = args['max-running'] || 1;
const apiKeyRunTest = args['run-test-api-key'] || '';
const apiKeyCheckTest = args['check-test-api-key'] || '';
const apiKeyDeleteTest = args['delete-test-api-key'] || '';

const refreshTimeInSeconds = 30;
const testName = 'test.jmx';
const reportName = 'report.jtl';
const resultsFolder = 'results';
const stdoutName = 'output.txt';
const stderrName = 'error.txt';
const metadataName = 'metadata.json';

const testFolderBase = args['test-folder-base'];
if (!testFolderBase) {
  exitWithError('missing value for mandatory argument "--test-folder-base".');
}
const baseFolder = fs.realpathSync(testFolderBase);

if (!fs.existsSync(baseFolder)) {
  fs.mkdirSync(baseFolder);
}

function checkApiKey(request: any, apiKey: string): boolean {
  return !apiKey || request.headers['x-api-key'] === apiKey;
}
async function getSubDirectories(source: string) {
  return (await fsp.readdir(source, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name);
}

function runningCount() {
  return Object.values(_database).filter(x => !x.done);
}

function deleteTest(test: TestRun): string {
  const id = test.id;

  if (!test.done) {
    return `Test ${id} is still running.`
  }

  const folder = path.join(baseFolder, id);
  fs.rmSync(folder, { recursive: true, force: true });
  delete _database[id];
  return '';
}

server.register(fastifyStatic, {
  root: baseFolder,
  prefix: '/test',
  allowedPath: (pathName) => !pathName.endsWith(metadataName)
});

server.addHook('onReady', async () => {
  const folders = await getSubDirectories(baseFolder);
  folders.forEach(id => {
    const metadata = path.join(baseFolder, id, metadataName);
    const test = JSON.parse(fs.readFileSync(metadata).toString());
    _database[id] = test;
  })
});

server.addHook('onClose', async () => {
  Object.keys(_database).forEach(id => {
    const metadata = path.join(baseFolder, id, metadataName);
    if (!fs.existsSync(metadata)) {
      const test = _database[id];
      fs.writeFileSync(metadata, JSON.stringify(test));
    }
  });
})

server.addHook('onResponse', (request, reply, done) => {
  if (!silent) {
    const method = request.method;
    const statusCode = reply.statusCode;
    console.info(`[INFO] ${method} ${request.url}${method === 'POST' ? ' ' + request.headers['content-type'] : ''} ${statusCode}`);
  }
  done();
});

server.addContentTypeParser(['application/xml'], { parseAs: 'string' }, function (_, body, done) {
  done(null, body);
})

server.post('/test', async (request, reply) => {
  try {
    if (!checkApiKey(request, apiKeyRunTest)) {
      return reply.status(401).send('');
    }

    if (runningCount().length >= maxRunning) {
      return reply.status(503)
        .header('content-type', 'text/plain')
        .send(`Cannot start new test run as the maximum (${maxRunning}) simultaneous tests runs are currently running. Try again later.`);
    }

    const id = uuidv4();
    const folder = path.join(baseFolder, id);
    fs.mkdirSync(folder);

    const body = request.body as string;
    await fsp.writeFile(path.join(folder, testName), body);

    const stdout = path.join(folder, stdoutName);
    const stderr = path.join(folder, stderrName);

    const timestamp = new Date().toISOString();

    _database[id] = {
      id: id,
      timestamp: timestamp,
      stdout: stdout,
      stderr: stderr,
      done: false
    } as TestRun;

    const jmeter = cp.spawn('jmeter', ['-n', '-t', `${testName}`, '-l', `${reportName}`, '-e', '-o', `${resultsFolder}`], { cwd: folder });
    jmeter.on('close', (code) => {
      const test = _database[id]!;
      test.done = true;
      test.code = code;
    });
    jmeter.stdout.pipe(fs.createWriteStream(stdout, { flush: true, emitClose: false }));
    jmeter.stderr.pipe(fs.createWriteStream(stderr, { flush: true, emitClose: false }));

    const statusUrl = `${baseUrl}/test/${id}`;
    const resultsUrl = `${statusUrl}/results/`;
    reply.status(201).send({ id: id, status: statusUrl, results: resultsUrl });
  } catch (error: any) {
    console.error('[ERROR] ', error);
    reply.status(500);
  }
});

server.get('/test', async (request, reply) => {
  if (!checkApiKey(request, apiKeyCheckTest)) {
    return reply.status(401).send('');
  }

  const tests = Object.values(_database);
  if (!tests.length) {
    const body = `<!DOCTYPE html><html><head><title>Tests Overview</title></head><body>No tests found.</body></html>`;
    return reply.header('content-type', 'text/html').send(body);
  }
  
  const refresh = runningCount().length ? `<meta http-equiv="refresh" content="${refreshTimeInSeconds}">` : '';
  const list = tests
    .sort((f,s) => Date.parse(f.timestamp) - Date.parse(s.timestamp))
    .map(test => {
      if(test.done) {
        return `<li>Test run started at ${test.timestamp}: <a href="${baseUrl}/test/${test.id}/results/" target="_blank">results</a></li>`;
      } else {
        return `<li>Test run started at ${test.timestamp}: <a href="${baseUrl}/test/${test.id}" target="_blank">status</a></li>`;
      }
    }).join('');
  const body = `<!DOCTYPE html><html><head><title>Tests Overview</title>${refresh}</head><body><h2>All tests</h2><ul>${list}</ul></body></html>`;
  reply.header('content-type', 'text/html').send(body);
});

server.get('/test/:id', async (request, reply) => {
  if (!checkApiKey(request, apiKeyCheckTest)) {
    return reply.status(401).send('');
  }

  const { id } = request.params as { id: string };
  const test = _database[id];
  if (test) {
    const stdout = fs.readFileSync(test.stdout).toString();
    const stderr = fs.readFileSync(test.stderr).toString();
    const refresh = !stdout.endsWith('... end of run\n') ? `<meta http-equiv="refresh" content="${refreshTimeInSeconds}">` : '';
    const body = `<!DOCTYPE html><html><head><title>Test ${id}</title>${refresh}</head><body><h2>Test run started at ${test.timestamp}</h2><pre>${stderr}</pre><hr/><pre>${stdout}</pre></body></html>`;
    reply.header('content-type', 'text/html').send(body);
  } else {
    reply.status(404).send('');
  }
});

server.delete('/test', async (request, reply) => {
  if (!checkApiKey(request, apiKeyDeleteTest)) {
    return reply.status(401).send('');
  }

  const responses = Object.values(_database).map(x => deleteTest(x)).filter(x => !!x);
  if (responses.length > 0) {
    const response = responses.join('\n');
    reply.status(405).send(response);
  } else {
    reply.send('All tests deleted');
  }
});

server.delete('/test/:id', async (request, reply) => {
  if (!checkApiKey(request, apiKeyDeleteTest)) {
    return reply.status(401).send('');
  }

  const { id } = request.params as { id: string };
  const test = _database[id];
  if (test) {
    const response = deleteTest(test);
    if (response) {
      reply.status(405).send(response);
    } else {
      reply.send(`Test ${test.id} deleted`);
    }
  } else {
    reply.status(404).send('');
  }
});

async function closeGracefully(signal: any) {
  if (!silent) {
    console.debug(`Received signal: `, signal);
  }
  await server.close();
  process.exitCode = 0;
}

process.on('SIGINT', closeGracefully);

function exitWithError(error: any) {
  console.error('[ERROR] ', error);
  process.exit(1);
}

const options = { port: port, host: host };
server.listen(options, async (err: any, address: string) => {
  if (err) {
    exitWithError(err);
  }
  if (!silent) {
    console.debug(`Test runner listening at ${address}`);
  }
});
