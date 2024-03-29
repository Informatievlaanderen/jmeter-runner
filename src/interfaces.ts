import { Registry, PrometheusContentType } from 'prom-client';

export interface JMeterStringProp {
  _name: string,
  _text: string
}

export interface JMeterElementProp {
  _name: string,
  stringProp: JMeterStringProp[]
}

export interface JMeterCollectionProp {
  elementProp: JMeterElementProp[]
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
        Arguments: JMeterArguments[]
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
  baseFolder: string,
  baseUrl: string,
  logFolder: string,
  refreshTimeInSeconds: number,
  silent: boolean,
  register: Registry<PrometheusContentType>,
  customLabels: string[],
}