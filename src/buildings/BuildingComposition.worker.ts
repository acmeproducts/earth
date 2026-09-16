import { exposeWorkerTask, type WorkerTaskScope } from "../core/workers/WorkerTask";
import type { BuildingSource } from "./BuildingPlanner";
import { runBuildingComposition, type BuildingCompositionOutput } from "./BuildingCompositionTask";

exposeWorkerTask(self as unknown as WorkerTaskScope<readonly BuildingSource[], BuildingCompositionOutput>, runBuildingComposition);
