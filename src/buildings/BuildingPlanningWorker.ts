import { PlanningWorkerClient } from "../core/workers/PlanningWorkerClient";
import type { BuildingPlanningInput, BuildingPlanningOutput } from "./BuildingPlanningTask";

export class BuildingPlanningWorker extends PlanningWorkerClient<
  BuildingPlanningInput, BuildingPlanningOutput, BuildingPlanningOutput["result"]
> {
  constructor() {
    super(() => new Worker(new URL("./BuildingPlanning.worker.ts", import.meta.url),
      { type: "module", name: "building-planning" }), output => output.result);
  }
}
