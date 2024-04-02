import fastify from 'fastify'
import fastifyStatic from '@fastify/static';
import minimist from 'minimist'
import fs from 'node:fs';
import { Registry, collectDefaultMetrics } from 'prom-client';

import { Controller, metadataName } from './controller';
import { ControllerConfig } from './interfaces';

const megabyte = 1048576;
const server = fastify({ bodyLimit: 10 * megabyte });

const register = new Registry();
register.setDefaultLabels({ app: 'jmeter-runner' });

collectDefaultMetrics({
  register: register,
  prefix: 'node_',
});

server.get('/prometheus', async (_, reply) => {
  reply.header('Content-Type', register.contentType).send(await register.metrics());
});


const args = minimist(process.argv.slice(2));
const silent: boolean = (/true/i).test(args['silent']);
if (!silent) {
  console.debug("Arguments: ", args);
}

const port = args['port'] || 80;
const host = args['host'] || 'localhost';
const baseUrl = args['base-url'] || `http://${host}:${port}`;

const maxRunning = args['max-running'] || 1;
const apiKeyRunTest = args['run-test-api-key'] || '';
const apiKeyCheckTest = args['check-test-api-key'] || '';
const apiKeyDeleteTest = args['delete-test-api-key'] || '';
const refreshTimeInSeconds = args['refresh-time'] || 30;
const labels: string = args['custom-labels'];
const customLabels = labels?.split(' ') || [];

const testFolderBase = args['test-folder-base'] || './tests';
const baseFolder = fs.realpathSync(testFolderBase);
if (!fs.existsSync(baseFolder)) {
  fs.mkdirSync(baseFolder);
}
console.info("Storing data in: ", baseFolder);

let logFolder = './logs';
if (!fs.existsSync(logFolder)) {
  fs.mkdirSync(logFolder);
}
logFolder = fs.realpathSync(logFolder);
console.info("Storing logs in: ", logFolder);

const controller = new Controller({ baseFolder, baseUrl, refreshTimeInSeconds, logFolder, silent, register, customLabels } as ControllerConfig);

function checkApiKey(request: any, apiKey: string): boolean {
  return !apiKey || request.headers['x-api-key'] === apiKey;
}

server.register(fastifyStatic, {
  root: baseFolder,
  prefix: '/',
  allowedPath: (pathName) => !pathName.endsWith(metadataName)
});

server.addHook('onReady', async () => {
  try {
    await controller.importTestRuns();
  } catch (error) {
    console.error('Failed to import metadata because: ', error);
  }
});

server.addHook('onClose', async () => {
  try {
    await controller.exportTestRuns();
  } catch (error) {
    console.error('Failed to export metadata because: ', error);
  }
})

server.addHook('onResponse', (request, reply, done) => {
  if (!silent) {
    const method = request.method;
    const statusCode = reply.statusCode;
    console.debug(`[INFO] ${method} ${request.url}${method === 'POST' ? ' ' + request.headers['content-type'] : ''} ${statusCode}`);
  }
  done();
});

server.addContentTypeParser(['application/xml'], { parseAs: 'string' }, function (_, body, done) {
  done(null, body);
})

server.post('/', { schema: { querystring: { category: { type: 'string' } } } }, async (request, reply) => {
  if (!checkApiKey(request, apiKeyRunTest)) {
    return reply.status(401).send('');
  }

  try {
    if (controller.runningCount >= maxRunning) {
      return reply.status(503)
        .header('content-type', 'text/plain')
        .send(`Cannot start new test run as the maximum (${maxRunning}) simultaneous tests runs are currently running. Try again later.\n`);
    }

    const parameters = request.query as { category?: string };
    const body = request.body as string;
    const response = await controller.scheduleTestRun(body, parameters.category);
    return reply.status(201).send(response);
  } catch (error: any) {
    console.error('[ERROR] ', error);
    return reply.status(500);
  }
});


server.get('/', async (request, reply) => {
  if (!checkApiKey(request, apiKeyCheckTest)) {
    return reply.status(401).send('');
  }

  try {
    const body = controller.getTestRunsOverview();
    return reply.header('content-type', 'text/html').send(body);
  } catch (error) {
    return reply.send({ msg: 'Cannot display test runs overview\n', error: error });
  }
});

server.get('/:id', { schema: { querystring: { limit: { type: 'number' } } } }, async (request, reply) => {
  if (!checkApiKey(request, apiKeyCheckTest)) {
    return reply.status(401).send('');
  }

  const parameters = request.query as { limit?: number };
  const { id } = request.params as { id: string };

  try {
    if (controller.testExists(id)) {
      const body = await controller.getTestRunStatus(id, parameters.limit);
      return reply.header('content-type', 'text/html').send(body);
    } else {
      return reply.status(404).send('');
    }
  } catch (error) {
    return reply.send({ msg: `Cannot display status for test run ${id}\n`, error: error });
  }
});

server.delete('/', { schema: { querystring: { confirm: { type: 'boolean' } } } }, async (request, reply) => {
  if (!checkApiKey(request, apiKeyDeleteTest)) {
    return reply.status(401).send('');
  }

  const parameters = request.query as { confirm?: boolean };

  try {
    if (controller.runningCount > 0 && !parameters.confirm) {
      return reply.status(405).send("Cannot delete all tests as some are still running.\nHint:pass query parameter '?confirm=true'.\n");
    } else {
      controller.deleteAllTestRuns();
      return reply.send('All tests deleted\n');
    }
  } catch (error) {
    return reply.send({ msg: 'Cannot delete all tests\n', error: error });
  }
});

server.delete('/:id', { schema: { querystring: { confirm: { type: 'boolean' } } } }, async (request, reply) => {
  if (!checkApiKey(request, apiKeyDeleteTest)) {
    return reply.status(401).send('');
  }

  const { id } = request.params as { id: string };
  const parameters = request.query as { confirm?: boolean };

  try {
    if (controller.testRunning(id) && !parameters.confirm) {
      return reply.status(405).send(`Test ${id} is still running.\nHint:pass query parameter '?confirm=true'.\n`);
    } else {
      const deleted = controller.deleteTest(id);
      if (deleted) {
        return reply.send(`Test ${id} deleted\n`);
      } else {
        return reply.status(404).send(`Test ${id} not found\n`);
      }
    }
  } catch (error) {
    return reply.send({ msg: `Cannot delete test ${id}\n`, error: error });
  }
});

async function closeGracefully(signal: any) {
  console.info(`Received signal: `, signal);
  await server.close();
  process.exit(0);
}

process.on('SIGTERM', closeGracefully);
process.on('SIGQUIT', closeGracefully);
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
  console.info(`Test runner listening at ${address}`);
});
