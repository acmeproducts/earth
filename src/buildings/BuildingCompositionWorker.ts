import { WorkerTaskClient } from "../core/workers/WorkerTaskClient";
import { recordWorkerStages } from "../diagnostics/StreamingDiagnostics";
import type { BuildingSource } from "./BuildingPlanner";
import type { BuildingCompositionOutput } from "./BuildingCompositionTask";

export class BuildingCompositionWorker {
  private readonly client = new WorkerTaskClient<readonly BuildingSource[], BuildingCompositionOutput>(() =>
    new Worker(new URL("./BuildingComposition.worker.ts", import.meta.url), { type: "module", name: "building-composition" }));

  async compose(sources: readonly BuildingSource[], label: string): Promise<readonly BuildingSource[]> {
    const output = await this.client.run(sources);
    recordWorkerStages(label, output.timings, output.timeOrigin);
    return output.result;
  }

  reset(): void { this.client.reset(); }
  dispose(): void { this.client.dispose(); }
}
