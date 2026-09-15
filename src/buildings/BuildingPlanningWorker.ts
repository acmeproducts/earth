import { WorkerTaskClient } from "../core/workers/WorkerTaskClient";
import { recordWorkerStages } from "../diagnostics/StreamingDiagnostics";
import type { BuildingPlanningInput, BuildingPlanningOutput } from "./BuildingPlanningTask";

export class BuildingPlanningWorker {
  private readonly client = new WorkerTaskClient<BuildingPlanningInput, BuildingPlanningOutput>(() =>
    new Worker(new URL("./BuildingPlanning.worker.ts", import.meta.url), { type: "module", name: "building-planning" }));

  async plan(input: BuildingPlanningInput, label: string) {
    const output = await this.client.run(input);
    recordWorkerStages(label, output.timings, output.timeOrigin);
    return output.result;
  }

  reset(): void { this.client.reset(); }
  dispose(): void { this.client.dispose(); }
}
