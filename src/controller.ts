import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Mustache from 'mustache';
import _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import * as cp from 'node:child_process';
import { XMLParser } from "fast-xml-parser";
import { read } from 'read-last-lines';

import { JMeterTest, TestRun, TestRunStatus, ControllerConfig } from "./interfaces";
import { Gauge } from 'prom-client';

export const metadataName = 'metadata.json';
const testName = 'test.jmx';
const reportName = 'report.jtl';
const outputName = 'output.log';
const resultsFolder = 'results';
const statusTemplate = 'status.html';
const overviewTemplate = 'overview.html';

interface Test {
  run: TestRun;
  process: cp.ChildProcessWithoutNullStreams | undefined;
}

interface TestRunDatabase {
  [key: string]: Test
}

type Labels = { [x in string]: string | undefined };

enum ControllerStatus {
  idle = 'IDLE',
  running = 'RUNNING',
  paused = 'PAUSED',
}

export class Controller {
  private _status: ControllerStatus = ControllerStatus.idle;
  private _testsById: TestRunDatabase = {};
  private _testParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '_', textNodeName: '_text' });
  private _testDuration?: Gauge;
  private _statusTemplate: string | undefined = undefined;
  private _overviewTemplate: string | undefined = undefined;

  private get status() {
    return this._status;
  }

  private set status(status: ControllerStatus) {
    console.debug(`[DEBUG] setting controller status to ${status}`);
    this._status = status;

    if (status === ControllerStatus.idle) {
      const firstQueued = this._testRunsByTimestamp([TestRunStatus.queued]).shift();
      if (firstQueued) {
        console.debug(`[DEBUG] running queued test ${firstQueued.id}`);
        this._runTest(firstQueued);
      }
    }
  }

  private get _tests() {
    return Object.values(this._testsById);
  }

  private _getTest(id: string) {
    return this._testsById[id];
  }

  private _upsertTest(test: Test) {
    this._testsById[test.run.id] = test;
    return test;
  }

  private async _getSubDirectories(source: string) {
    return (await fsp.readdir(source, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name);
  }

  private _importTest(id: string) {
    const metadata = path.join(this._config.testFolder, id, metadataName);
    if (fs.existsSync(metadata)) {
      const fd = fs.openSync(metadata, 'r');
      try {
        const content = fs.readFileSync(fd, { encoding: 'utf8' });
        const run = JSON.parse(content) as TestRun;
        if (run.status === TestRunStatus.running) {
          run.status = TestRunStatus.cancelled; // just in case
        }
        this._upsertTest({ run: run, process: undefined } as Test);
      } finally {
        fs.closeSync(fd);
      }
    }
  }

  private _exportTestRun(run: TestRun) {
    this._writeMetadata(run);
    this._moveToResults(run.id);
  }

  private _cancelTest(test: Test) {
    const id = test.run.id;

    if (test.process) {
      console.warn(`[WARN] Test ${id} is running...`);
      const process = test.process;
      console.warn(`[WARN] Killing pid ${process?.pid}...`);
      const killed = process?.kill();
      console.warn(killed ? `[WARN] Test ${id} was cancelled.` : `Failed to kill test ${id} (pid: ${process?.pid}).`);

      // Note: if we kill a process, the system under test (SUT) can be in an invalid state, 
      //       so pause running tests until SUT back in a consistent state and we are resumed.
      this.status = ControllerStatus.paused;
    }

    return this._upsertTest({ run: { ...test.run, status: TestRunStatus.cancelled } as TestRun, process: undefined } as Test);
  }

  private _writeMetadata(run: TestRun) {
    const metadata = path.join(this._config.tempFolder, run.id, metadataName);
    this._write(metadata, JSON.stringify(run));
  }

  private _read(fullPathName: string) {
    return fs.readFileSync(fullPathName, { encoding: 'utf8' });
  }

  private _write(fullPathName: string, data: string) {
    fs.writeFileSync(fullPathName, data, { encoding: 'utf8', flush: true });
  }

  private _moveToResults(id: string) {
    const tempPath = path.join(this._config.tempFolder, id);
    const testPath = path.join(this._config.testFolder, id);

    // NOTE: 
    //   node.js uses chmod to cp the permissions for each file & folder to the destination,
    //   however this is not permitted on a S3 bucket destination. 
    // fs.cpSync(tempPath, testPath, { recursive: true });
    // fs.rmSync(tempPath, { recursive: true });
    const cmd = `cp -r ${tempPath} ${testPath} && rm -rf ${tempPath}`;
    cp.exec(cmd, (error: cp.ExecException | null, stdout: string, stderr: string) => {
      if (error) {
        console.error(`[ERROR] failed to move test ${id}, please move manually`);
      } else if (stderr) {
        console.warn(`[WARN] something went wrong while moving test ${id}: ${stderr}`);
      } else if (stderr) {
        console.info(`[INFO] moved test ${id}: ${stdout}`);
      }
    })
  }

  private _testRunsByTimestamp(filterByStatus?: TestRunStatus[]) {
    return this._tests
      .map(x => x.run)
      .filter(x => filterByStatus ? filterByStatus.includes(x.status) : true)
      .sort((f, s) => Date.parse(f.timestamp) - Date.parse(s.timestamp));
  }

  private async _queueTest(body: string, category: string | undefined): Promise<Test> {
    const id = uuidv4();
    const folder = path.join(this._config.tempFolder, id);
    fs.mkdirSync(folder);

    await fsp.writeFile(path.join(folder, testName), body);

    const parsed = this._testParser.parse(body) as JMeterTest;
    const testPlan = parsed.jmeterTestPlan.hashTree.TestPlan;
    const timestamp = new Date().toISOString();
    const run = {
      id: id,
      name: testPlan._testname,
      category: category,
      timestamp: timestamp,
      status: TestRunStatus.queued,
    } as TestRun;
    this._writeMetadata(run);

    const test = { run: run, process: undefined } as Test;
    return this._upsertTest(test);
  }

  private async _runTest(testRun: TestRun): Promise<void> {
    const id = testRun.id;
    const folder = path.join(this._config.tempFolder, id);

    const endTimer = this._testDuration?.startTimer();
    const timestamp = new Date().toISOString();
    const jmeter = cp.spawn('jmeter', ['-n', '-t', `${testName}`, '-l', `${reportName}`, '-e', '-o', `${resultsFolder}`], { cwd: folder });

    const run = {
      ...testRun,
      timestamp: timestamp,
      status: TestRunStatus.running
    } as TestRun;
    this._writeMetadata(run);

    this._upsertTest({ run: run, process: jmeter } as Test);
    this.status = ControllerStatus.running;

    const logs = path.join(folder, outputName);
    jmeter.stdout.pipe(fs.createWriteStream(logs, { encoding: 'utf8', flags: 'a', flush: true, autoClose: true, emitClose: false }));

    jmeter.on('close', async (code, signal) => {
      try {
        if (!signal) {
          let duration: number | undefined;
          try {
            const body = await fsp.readFile(path.join(folder, testName));
            const parsed = this._testParser.parse(body) as JMeterTest;
            const args = parsed.jmeterTestPlan.hashTree.hashTree.Arguments;
            const elements = Array.isArray(args) && args?.find(x => x._testname === 'Labels')?.collectionProp?.elementProp;
            const labels = Array.isArray(elements) && elements
              .map(x => ({
                key: x._name,
                value: Array.isArray(x.stringProp)
                  ? x.stringProp.find(s => s._name === 'Argument.value')?._text
                  : (x.stringProp._name === 'Argument.value' ? x.stringProp._text : undefined)
              }))
              .reduce<Labels>((a, x) => (a[x.key] = x.value?.toString(), a), {});
            duration = endTimer && endTimer({ ...labels, category: run.category, name: run.name });
          } catch (error) {
            console.warn(`[WARN] Cannot calculate duration for test ${id} because: ${error}`);
            duration = undefined;
          }
          const updatedTest = { run: { ...run, status: TestRunStatus.done, code: code, duration: duration }, process: jmeter } as Test;
          const updatedRun = this._upsertTest(updatedTest).run;
          this._writeMetadata(updatedRun);
          this._moveToResults(updatedRun.id);
          this.status = code === 0 ? ControllerStatus.idle : ControllerStatus.paused;
        } else {
          console.warn(`[WARN] received signal ${signal} for test ${id}`);
        }
      } catch (error) {
        console.error(`[ERROR] Failed to write metadata because: ${error}`);
      }
    });
  }

  private async _importTestsAndRuns() {
    const runs = await this._getSubDirectories(this._config.tempFolder);
    runs.forEach(id => this._moveToResults(id));

    const tests = await this._getSubDirectories(this._config.testFolder);
    tests.forEach(id => this._importTest(id));
  }

  public async _exportTestRuns() {
    const runs = await this._getSubDirectories(this._config.tempFolder);
    runs.forEach(id => this.cancelTest(id));
  }

  constructor(private _config: ControllerConfig) {
    const defaultLabels = ['category', 'name'];
    this._testDuration = new Gauge({
      name: 'jmeter_test_duration',
      help: 'jmeter test duration (in seconds)',
      labelNames: this._config.customLabels.length ? [...this._config.customLabels, ...defaultLabels] : defaultLabels,
    });
    _config.register.registerMetric(this._testDuration);
  }

  public async initialize() {
    const cwd = this._config.cwd;
    this._statusTemplate = await fsp.readFile(`${cwd}/${statusTemplate}`, {encoding: 'utf8'});
    this._overviewTemplate = await fsp.readFile(`${cwd}/${overviewTemplate}`, {encoding: 'utf8'});

    try {
      await this._importTestsAndRuns();
    } catch (error) {
      console.error('[ERROR] Failed to import metadata because: ', error);
    }
  }

  public async terminate() {
    try {
      await this._exportTestRuns();
    } catch (error) {
      console.error('[ERROR] Failed to export metadata because: ', error);
    }
  }

  public get runningCount(): number {
    return Object.values(this._testsById).filter(x => x.run.status == TestRunStatus.running).length;
  }

  public testExists(id: string): boolean {
    return this._getTest(id) != undefined;
  }

  public testRunning(id: string): boolean {
    const test = this._getTest(id);
    return !!test && test.run.status === TestRunStatus.running;
  }

  public testStatus(id: string): TestRunStatus | undefined {
    const test = this._getTest(id);
    return test && test.run.status;
  }

  public cancelTest(id: string) {
    const test = this._getTest(id);
    if (test) {
      this._exportTestRun(this._cancelTest(test).run);
    }
  }

  public deleteTest(id: string) {
    const testData = path.join(this._config.testFolder, id);
    const runData = path.join(this._config.tempFolder, id);

    const exists = this.testExists(id);
    if (exists) {
      if (this.testRunning(id)) {
        const test = this._getTest(id)!;
        this._cancelTest(test);
      }
      delete this._testsById[id];
    } else {
      console.warn(`[WARN] Test ${id} does not exist (in memory DB) but trying to remove test data (${testData}).`);
    }

    const testDataExists = fs.existsSync(testData);
    if (testDataExists) {
      if (!this._config.silent) console.info(`[INFO] Deleting test data at ${testData}...`);
      fs.rmSync(testData, { recursive: true, force: true });
      console.warn(`[WARN] Deleted test data at ${testData}.`);
    }

    const runDataExists = fs.existsSync(runData);
    if (testDataExists) {
      if (!this._config.silent) console.info(`[INFO] Deleting test run data at ${runData}...`);
      fs.rmSync(runData, { recursive: true, force: true });
      console.warn(`[WARN] Deleted test run data at ${runData}.`);
    }

    return exists || testDataExists || runDataExists;
  }

  public deleteAllTests() {
    this._tests.map(x => this.deleteTest(x.run.id));
  }

  public cancelAllRunningTests() {
    this._tests.map(x => {
      if (x.process && !x.process.exitCode) {
        this.cancelTest(x.run.id)
      }
    });
  }

  public async getTestRunStatus(id: string, limit: number = 1000) {
    const test = this._getTest(id);
    if (!test) throw new Error(`Test ${id} does not exist.`);

    const logs = path.join(this._config.tempFolder, id, outputName);
    const output = limit ? await read(logs, limit) : this._read(logs);
    const data = {
      ...test.run,
      refresh: test.run.status === TestRunStatus.running ? this._config.refreshTimeInSeconds : false,
      output: output,
    };
    return Mustache.render(this._statusTemplate!, data);
  }

  public getTestRunsOverview(baseUrl: string) {
    const runs = this._testRunsByTimestamp([TestRunStatus.done, TestRunStatus.cancelled])
      .map(run => ({
        ...run,
        link: `${baseUrl}/${run.id}/${(run.status === TestRunStatus.done ? 'results/' : 'jmeter.log')}`,
        text: run.status === TestRunStatus.done ? 'results' : 'output',
        stats: run.status === TestRunStatus.done ? `${baseUrl}/${run.id}/stats.xml` : null,
      }));

    const runsGroupedByCategory = _.groupBy(runs, (run: { category?: string }) => run.category);
    const runsByCategoryAndName = _.orderBy(_.keys(runsGroupedByCategory)).map(x => {
      const categoryGroupedByName = _.groupBy(runsGroupedByCategory[x] || [], (run: { name: string }) => run.name);
      const categoryByName = _.orderBy(_.keys(categoryGroupedByName)).map(x => ({ name: x, group: categoryGroupedByName[x] || [] }));
      return { category: x, group: categoryByName };
    });

    let current = undefined;
    let action = undefined;

    switch (this.status) {
      case ControllerStatus.running: {
        const running = this._tests.find(x => x.run.status === TestRunStatus.running)!.run;
        action = { label: 'Cancel', onClick: `cancelTest('${running.id}', {'x-api-key':'${this._config.keys.deleteTest}'})` };
        current = { ...running, link: `${baseUrl}/${running.id}`, text: 'status' };
        break;
      }
      case ControllerStatus.paused: {
        action = { label: 'Resume', onClick: `resume({'x-api-key':'${this._config.keys.runTest}'})` };
        break;
      }
      case ControllerStatus.idle: break;
      default: break;
    }

    const queued = this._testRunsByTimestamp([TestRunStatus.queued]);

    const data = {
      status: this.status,
      queued: queued,
      current: current,
      action: action,
      refresh: this._config.refreshTimeInSeconds,
      tests: runsByCategoryAndName,
    };
    return Mustache.render(this._overviewTemplate!, data);
  }

  public async scheduleTestRun(body: string, category: string | undefined) {
    const test = await this._queueTest(body, category);

    if (this.status === ControllerStatus.idle) {
      this._runTest(test.run);
    }

    return { id: test.run.id };
  }

  public resume() {
    this.status = ControllerStatus.idle;
    return { status: this.status };
  }

}