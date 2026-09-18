import { WorkerTaskClient } from "./WorkerTaskClient";
import { recordWorkerStages } from "../../diagnostics/StreamingDiagnostics";

interface TimedOutput {
  timings: Parameters<typeof recordWorkerStages>[1];
  timeOrigin: number;
}

/** Keeps planning-worker timing and lifecycle behavior consistent across tasks. */
export class PlanningWorkerClient<Input, Output extends TimedOutput, Result> {
  private readonly client: WorkerTaskClient<Input, Output>;
  private readonly result: (output: Output) => Result;

  constructor(createWorker: () => Worker, result: (output: Output) => Result) {
    this.client = new WorkerTaskClient(createWorker);
    this.result = result;
  }

  async plan(input: Input, label: string): Promise<Result> {
    const output = await this.client.run(input);
    recordWorkerStages(label, output.timings, output.timeOrigin);
    return this.result(output);
  }

  reset(): void { this.client.reset(); }
  dispose(): void { this.client.dispose(); }
}
