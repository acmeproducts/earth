import { exposeWorkerTask, type WorkerTaskScope } from "../core/workers/WorkerTask";
import { runBuildingPlanningTask, type BuildingPlanningInput, type BuildingPlanningOutput } from "./BuildingPlanningTask";

exposeWorkerTask(self as unknown as WorkerTaskScope<BuildingPlanningInput, BuildingPlanningOutput>, runBuildingPlanningTask);
