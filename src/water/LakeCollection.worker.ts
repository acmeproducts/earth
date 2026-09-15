import { exposeWorkerTask, type WorkerTaskScope } from "../core/workers/WorkerTask";
import { runLakeCollectionTask, type LakeCollectionInput, type LakeCollectionOutput } from "./LakeCollectionTask";

exposeWorkerTask(self as unknown as WorkerTaskScope<LakeCollectionInput, LakeCollectionOutput>, runLakeCollectionTask);
