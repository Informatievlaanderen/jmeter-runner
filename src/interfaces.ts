export interface JMeterTest {
  jmeterTestPlan: {
    hashTree: {
      TestPlan: {
        _testname: string
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
  stdout: string;
  status: TestRunStatus;
  code: number | null;
}

export interface TestRunDatabase {
  [key: string]: TestRun
}
