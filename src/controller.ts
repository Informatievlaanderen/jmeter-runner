import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Mustache from 'mustache';
import _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import * as cp from 'node:child_process';
import { XMLParser } from "fast-xml-parser";
import { read } from 'read-last-lines';

import { JMeterTest, TestRun, TestRunStatus } from "./interfaces";

export const metadataName = 'metadata.json';
const testName = 'test.jmx';
const reportName = 'report.jtl';
const resultsFolder = 'results';

const statusTemplate = '<!DOCTYPE html><html>\
  <head><title>Test Run {{id}}</title>{{#refresh}}<meta http-equiv="refresh" content="{{.}}">{{/refresh}}</head>\
  <body><h1>Category: {{category}} - Test: {{name}}</h1>Test run started at {{timestamp}}<hr/><pre>{{output}}</pre></body></html>';

const noTestsFoundTemplate = '<!DOCTYPE html><html>\
  <head><title>Tests Overview</title><meta http-equiv="refresh" content="{{refresh}}"></head>\
  <body>No tests found.</body></html>';

const overviewTemplate = '<!DOCTYPE html><html>\
  <head><title>Test Runs Overview</title><meta http-equiv="refresh" content="{{refresh}}"></head>\
  <body><h1>Test Runs</h1>\
  {{#tests}}<h2>Category: {{category}}</h2>\
    {{#group}}<h3>Test: {{name}}</h3><ul>\
      {{#group}}\
        <li>Test run started at {{timestamp}}: {{status}}, see <a href="{{link}}" target="_blank">{{text}}</a></li>\
      {{/group}}</ul>\
    {{/group}}\
  {{/tests}}\
  </body></html>';


interface Test {
  run: TestRun;
  process: cp.ChildProcessWithoutNullStreams | undefined;
}

interface TestRunDatabase {
  [key: string]: Test
}

export class Controller {

  private _testsById: TestRunDatabase = {};
  private _testParser = new XMLParser({ stopNodes: ['jmeterTestPlan.hashTree.hashTree'], ignoreAttributes: false, attributeNamePrefix: '_' });

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

  private _cancelRunningTests() {
    Object.values(this._testsById).forEach(test => {
      if (test.run.status === TestRunStatus.running) {
        test.run.status = TestRunStatus.cancelled;
      }
    });
  }

  private _writeMetadata(run: TestRun) {
    const metadata = path.join(this._baseFolder, run.id, metadataName);
    this._write(metadata, JSON.stringify(run));
  }

  private _read(fullPathName: string) {
    return fs.readFileSync(fullPathName, { encoding: 'utf8' });
  }

  private _write(fullPathName: string, data: string) {
    fs.writeFileSync(fullPathName, data, { encoding: 'utf8', flush: true });
  }

  constructor(
    private _baseFolder: string,
    private _baseUrl: string,
    private _refreshTimeInSeconds: number,
    private _logFolder: string,
    private _silent: boolean) { }

  public get runningCount(): number {
    return Object.values(this._testsById).filter(x => x.run.status == TestRunStatus.running).length;
  }

  public async importTestRuns() {
    const folders = await this._getSubDirectories(this._baseFolder);
    folders.forEach(id => {
      const metadata = path.join(this._baseFolder, id, metadataName);
      if (fs.existsSync(metadata)) {
        const fd = fs.openSync(metadata, 'r');
        try {
          const content = fs.readFileSync(fd, { encoding: 'utf8' });
          const run = JSON.parse(content);
          this._upsertTest({ run: run, process: undefined } as Test);
        } finally {
          fs.closeSync(fd);
        }
      }
    })
    this._cancelRunningTests();
  }

  public async exportTestRuns() {
    this._cancelRunningTests();
    this._tests.forEach(test => this._writeMetadata(test.run));
  }

  public testExists(id: string): boolean {
    return this._getTest(id) != undefined;
  }

  public testRunning(id: string): boolean {
    const test = this._getTest(id);
    return !!test && test.run.status === TestRunStatus.running;
  }

  public deleteTest(id: string) {
    const testRunData = path.join(this._baseFolder, id);
    const logFile = path.join(this._logFolder, `${id}.log`);

    const exists = this.testExists(id);
    if (exists) {
      if (this.testRunning(id)) {
        console.warn(`[WARN] Test ${id} is running...`);
        const process = this._testsById[id]?.process;
        console.warn(`[WARN] Killing pid ${process?.pid}...`);
        const killed = process?.kill;
        console.warn(killed ? `[WARN] Test ${id} was cancelled.` : `Failed to kill test ${id} (pid: ${process?.pid}).`);
      }
      delete this._testsById[id];
    } else {
      console.warn(`[WARN] Test ${id} does not exist (in memory DB) but trying to remove test data (${testRunData}) and log file (${logFile}).`);
    }

    const testDataExists = fs.existsSync(testRunData);
    if (testDataExists) {
      if (!this._silent) console.info(`[INFO] Deleting test data at ${testRunData}...`);
      fs.rmSync(testRunData, { recursive: true, force: true });
      console.warn(`[WARN] Deleted test data at ${testRunData}.`);
    }

    const logFileExists = fs.existsSync(logFile);
    if (logFileExists) {
      if (!this._silent) console.info(`[INFO] Deleting log file at ${logFile}...`);
      fs.rmSync(logFile);
      console.warn(`[WARN] Deleted log file at ${logFile}.`);
    }

    return exists || testDataExists || logFileExists;
  }

  public deleteAllTestRuns() {
    this._tests.map(x => this.deleteTest(x.run.id));
  }

  public async getTestRunStatus(id: string, limit: number = 1000) {
    const test = this._getTest(id);
    if (!test) throw new Error(`Test ${id} does not exist.`);

    const logs = path.join(this._logFolder, `${id}.log`);
    const output = limit ? await read(logs, limit) : this._read(logs);
    const data = {
      ...test.run,
      refresh: test.run.status === TestRunStatus.running ? this._refreshTimeInSeconds : false,
      output: output,
    };
    return Mustache.render(statusTemplate, data);
  }

  public getTestRunsOverview() {
    const tests = this._tests;

    if (!tests.length) {
      return Mustache.render(noTestsFoundTemplate, { refresh: this._refreshTimeInSeconds });
    }

    const runs = tests
      .map(x => x.run)
      .sort((f, s) => Date.parse(f.timestamp) - Date.parse(s.timestamp))
      .map(test => {
        switch (test.status) {
          case TestRunStatus.done:
            return { ...test, link: `${this._baseUrl}/${test.id}/results/`, text: 'results' };
          case TestRunStatus.cancelled:
            return { ...test, link: `${this._baseUrl}/${test.id}`, text: 'output' };
          case TestRunStatus.running:
            return { ...test, link: `${this._baseUrl}/${test.id}`, text: 'status' };
          default:
            throw new Error(`Unknown test status: `, test.status);
        }
      });

    const runsGroupedByCategory = _.groupBy(runs, (run: { category?: string }) => run.category);
    const runsByCategoryAndName = _.keys(runsGroupedByCategory).map(x => {
      const categoryGroupedByName = _.groupBy(runsGroupedByCategory[x] || [], (run: { name: string }) => run.name);
      const categoryByName = _.keys(categoryGroupedByName).map(x => ({ name: x, group: categoryGroupedByName[x] || [] }));
      return { category: x, group: categoryByName };
    });

    const data = {
      refresh: this._refreshTimeInSeconds,
      tests: runsByCategoryAndName,
    };
    return Mustache.render(overviewTemplate, data);
  }

  public async scheduleTestRun(body: string, category: string | undefined) {
    const id = uuidv4();
    const folder = path.join(this._baseFolder, id);
    fs.mkdirSync(folder);

    await fsp.writeFile(path.join(folder, testName), body);

    const parsed = this._testParser.parse(body) as JMeterTest;
    const timestamp = new Date().toISOString();

    const jmeter = cp.spawn('jmeter', ['-n', '-t', `${testName}`, '-l', `${reportName}`, '-e', '-o', `${resultsFolder}`], { cwd: folder });
    const run = {
      id: id,
      name: parsed.jmeterTestPlan.hashTree.TestPlan._testname,
      category: category,
      timestamp: timestamp,
      status: TestRunStatus.running
    } as TestRun;
    const test = this._upsertTest({ run: run, process: jmeter } as Test);

    this._writeMetadata(test.run);

    jmeter.on('close', (code) => {
      try {
        const updatedTest = { run: { ...run, status: TestRunStatus.done, code: code }, process: jmeter } as Test;
        this._writeMetadata(this._upsertTest(updatedTest).run);
      } catch (error) {
        console.error('Failed to write metadata because: ', error);
      }
    });

    const logs = path.join(this._logFolder, `${id}.log`);
    jmeter.stdout.pipe(fs.createWriteStream(logs, { encoding: 'utf8', flags: 'a', flush: true, autoClose: true, emitClose: false }));

    const statusUrl = `${this._baseUrl}/${id}`;
    const resultsUrl = `${statusUrl}/results/`;
    return { id: id, status: statusUrl, results: resultsUrl };
  }

}