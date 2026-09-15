import { WorkerTaskClient } from "../core/workers/WorkerTaskClient";
import { recordWorkerStages } from "../diagnostics/StreamingDiagnostics";
import type { RoadPlanningInput, RoadPlanningOutput } from "./RoadPlanningTask";

export class RoadPlanningWorker {
  private readonly client = new WorkerTaskClient<RoadPlanningInput, RoadPlanningOutput>(() =>
    new Worker(new URL("./RoadPlanning.worker.ts", import.meta.url), { type: "module", name: "road-planning" }));

  async plan(input: RoadPlanningInput, label: string) {
    const result = await this.client.run(input);
    recordWorkerStages(label, result.timings, result.timeOrigin);
    return result.plan;
  }

  reset(): void { this.client.reset(); }
  dispose(): void { this.client.dispose(); }
}
