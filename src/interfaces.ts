import { Registry, PrometheusContentType } from 'prom-client';

export interface JMeterStringProp {
  _name: string,
  _text: string
}

export interface JMeterElementProp {
  _name: string,
  stringProp: JMeterStringProp | JMeterStringProp[]
}

export interface JMeterCollectionProp {
  elementProp: JMeterElementProp | JMeterElementProp[]
}

export interface JMeterArguments {
  _testname: string;
  collectionProp: JMeterCollectionProp;
}

export interface JMeterTest {
  jmeterTestPlan: {
    hashTree: {
      TestPlan: {
        _testname: string
      },
      hashTree: {
        Arguments: JMeterArguments | JMeterArguments[]
      }
    }
  }
}

export enum TestRunStatus {
  running = 'running',
  done = 'done',
  cancelled = 'cancelled',
}

export interface TestRun {
  id: string;
  category?: string;
  name: string;
  timestamp: string;
  status: TestRunStatus;
  code: number | undefined;
  duration: number | undefined;
}

export interface ControllerConfig {
  testFolder: string,
  tempFolder: string,
  baseUrl: string,
  refreshTimeInSeconds: number,
  silent: boolean,
  register: Registry<PrometheusContentType>,
  customLabels: string[],
}