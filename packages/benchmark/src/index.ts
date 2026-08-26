export interface TaskOutcome {
  taskId: string;
  modelId: string;
  taskType: string;
  result: string;
  retryCount: number;
  elapsedMs: number;
}

export class BenchmarkStore {
  record(outcome: TaskOutcome): void {}
  scoreFor(modelId: string, taskType: string): number {
    return 0;
  }
}
