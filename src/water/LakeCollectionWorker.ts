import { WorkerTaskClient } from "../core/workers/WorkerTaskClient";
import { recordWorkerStages } from "../diagnostics/StreamingDiagnostics";
import type { LakeCollectionInput, LakeCollectionOutput } from "./LakeCollectionTask";

export class LakeCollectionWorker {
  private readonly client = new WorkerTaskClient<LakeCollectionInput, LakeCollectionOutput>(() =>
    new Worker(new URL("./LakeCollection.worker.ts", import.meta.url), { type: "module", name: "lake-collection" }));

  async collect(input: LakeCollectionInput, label: string) {
    if (!input.candidates.length) return [];
    const result = await this.client.run(input);
    recordWorkerStages(label, result.timings, result.timeOrigin);
    return result.lakes;
  }

  reset(): void { this.client.reset(); }
  dispose(): void { this.client.dispose(); }
}
