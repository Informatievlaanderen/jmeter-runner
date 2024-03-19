import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Mustache from 'mustache';
import _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import * as cp from 'node:child_process';
import { XMLParser } from "fast-xml-parser";
import { read } from 'read-last-lines';

import { JMeterTest, TestRun, TestRunDatabase, TestRunStatus } from "./interfaces";

export const metadataName = 'metadata.json';
const testName = 'test.jmx';
const reportName = 'report.jtl';
const resultsFolder = 'results';
const stdoutName = 'output.txt';

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

export class Controller {

  private _testRunsById: TestRunDatabase = {};
  private _testParser = new XMLParser({ stopNodes: ['jmeterTestPlan.hashTree.hashTree'], ignoreAttributes: false, attributeNamePrefix: '_'});

  private get _testRuns() {
    return Object.values(this._testRunsById);
  }

  private _getTestRun(id: string) {
    return this._testRunsById[id];
  }

  private _upsertTestRun(run: TestRun) {
    this._testRunsById[run.id] = run;
    return run;
  }

  private _deleteTestRun(run: TestRun) {
    delete this._testRunsById[run.id];
    return run;
  }

  private async _getSubDirectories(source: string) {
    return (await fsp.readdir(source, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name);
  }

  private _cancelRunningTests() {
    Object.values(this._testRunsById).forEach(run => {
      if (run.status === TestRunStatus.running) {
        run.status = TestRunStatus.cancelled;
      }
    });
  }  

  private _writeMetadata(run: TestRun) {
    const metadata = path.join(this._baseFolder, run.id, metadataName);
    fs.writeFileSync(metadata, JSON.stringify(run), { encoding: 'utf8', flag: 'w', flush: true });
  }
  
  private _purgeTestRun(run: TestRun) {
    const id = run.id;
    if (run.status === TestRunStatus.running) {
      return `Test ${id} is still running.`
    }
  
    const folder = path.join(this._baseFolder, id);
    fs.rmSync(folder, { recursive: true, force: true });
    this._deleteTestRun(run);
    return '';
  }

  constructor(private _baseFolder: string, private _baseUrl: string, private _refreshTimeInSeconds: number) { }

  public get runningCount(): number {
    return Object.values(this._testRunsById).filter(x => x.status == TestRunStatus.running).length;
  }

  public async importTestRuns() {
    const folders = await this._getSubDirectories(this._baseFolder);
    folders.forEach(id => {
      const metadata = path.join(this._baseFolder, id, metadataName);
      if (fs.existsSync(metadata)) {
        const content = fs.readFileSync(metadata, {encoding: 'utf8', flag: 'r'});
        const run = JSON.parse(content);
        this._upsertTestRun(run);
      }
    })
    this._cancelRunningTests();
  }

  public async exportTestRuns() {
    this._cancelRunningTests();
    this._testRuns.forEach(run => this._writeMetadata(run));
  }

  public testRunExists(id: string): boolean {
      return this._getTestRun(id) != undefined;
  }

  public deleteTestRun(id: string): string {
    const run = this._getTestRun(id);
    if (!run) throw new Error(`Test ${id} does not exist.`);
    return this._purgeTestRun(run);
  }

  public deleteAllTestRuns(): string[] {
    return this._testRuns.map(x => this._purgeTestRun(x));
  }

  public async getTestRunStatus(id: string, limit: number = 1000) {
    const run = this._getTestRun(id);
    if (!run) throw new Error(`Test ${id} does not exist.`);
  
    const output = limit 
      ? await read(run.stdout, limit) 
      : fs.readFileSync(run.stdout, {encoding: 'utf8', flag: 'r'});

    const data = {
      ... run,
      refresh: run.status === TestRunStatus.running ? this._refreshTimeInSeconds : false,
      output: output,
    };
    return Mustache.render(statusTemplate, data);
  }

  public getTestRunsOverview() {
    const testRuns = this._testRuns;

    if (!testRuns.length) {
      return Mustache.render(noTestsFoundTemplate, { refresh: this._refreshTimeInSeconds });
    }
  
    const runs = testRuns
      .sort((f, s) => Date.parse(f.timestamp) - Date.parse(s.timestamp))
      .map(test => {
        switch (test.status) {
          case TestRunStatus.done:
            return { ... test, link: `${this._baseUrl}/${test.id}/results/`, text: 'results' };
          case TestRunStatus.cancelled:
            return { ... test, link: `${this._baseUrl}/${test.id}`, text: 'output' };
          case TestRunStatus.running:
            return { ... test, link: `${this._baseUrl}/${test.id}`, text: 'status' };
          default:
            throw new Error(`Unknown test status: `, test.status);
        }
      });
    
    const runsGroupedByCategory = _.groupBy(runs, (run: {category?: string}) => run.category);
    const runsByCategoryAndName = _.keys(runsGroupedByCategory).map(x => {
      const categoryGroupedByName = _.groupBy(runsGroupedByCategory[x] || [], (run: {name: string}) => run.name);
      const categoryByName = _.keys(categoryGroupedByName).map(x => ({name: x, group: categoryGroupedByName[x] || []}));
      return {category: x, group: categoryByName};
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
    const stdout = path.join(folder, stdoutName);
    const timestamp = new Date().toISOString();

    const run = {
      id: id,
      name: parsed.jmeterTestPlan.hashTree.TestPlan._testname,
      category: category,
      timestamp: timestamp,
      stdout: stdout,
      status: TestRunStatus.running
    } as TestRun;
    this._writeMetadata(this._upsertTestRun(run));

    const jmeter = cp.spawn('jmeter', ['-n', '-t', `${testName}`, '-l', `${reportName}`, '-e', '-o', `${resultsFolder}`], { cwd: folder });

    jmeter.on('close', (code) => {
      this._writeMetadata(this._upsertTestRun({ ...run, status: TestRunStatus.done, code: code }));
    });

    jmeter.stdout.pipe(fs.createWriteStream(stdout, { encoding: 'utf8', flags: 'w', flush: true, autoClose: true, emitClose: false }));

    const statusUrl = `${this._baseUrl}/${id}`;
    const resultsUrl = `${statusUrl}/results/`;
    return { id: id, status: statusUrl, results: resultsUrl };
  }

}