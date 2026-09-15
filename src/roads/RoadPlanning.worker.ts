import { exposeWorkerTask, type WorkerTaskScope } from "../core/workers/WorkerTask";
import { runRoadPlanningTask, type RoadPlanningInput, type RoadPlanningOutput } from "./RoadPlanningTask";

exposeWorkerTask(self as unknown as WorkerTaskScope<RoadPlanningInput, RoadPlanningOutput>, runRoadPlanningTask);
