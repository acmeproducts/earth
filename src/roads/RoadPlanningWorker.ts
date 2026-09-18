import { PlanningWorkerClient } from "../core/workers/PlanningWorkerClient";
import type { RoadPlanningInput, RoadPlanningOutput } from "./RoadPlanningTask";

export class RoadPlanningWorker extends PlanningWorkerClient<
  RoadPlanningInput, RoadPlanningOutput, RoadPlanningOutput["plan"]
> {
  constructor() {
    super(() => new Worker(new URL("./RoadPlanning.worker.ts", import.meta.url),
      { type: "module", name: "road-planning" }), output => output.plan);
  }
}
