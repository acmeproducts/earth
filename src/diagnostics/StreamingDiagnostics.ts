import { creationStats, SLOW_OPERATION_THRESHOLD_MS } from "./CreationStats";

const HISTORY_SIZE = 2048;
const SLOW_HISTORY_SIZE = 256;
interface StageTiming {
  traceId: number;
  label: string;
  stage: string;
  startTimeMilliseconds: number;
  durationMilliseconds: number;
  timingKind: "wall-clock" | "synchronous";
  executionThread: "main" | "worker";
  completed: boolean;
}
const history: StageTiming[] = [];
const slowHistory: StageTiming[] = [];
let slowHistoryCursor = 0;
const active = new Map<number, StreamingTrace>();
let nextTraceId = 0;
let historyCursor = 0;

export function streamingDiagnosticsSnapshot() {
  const now = performance.now();
  return {
    timeOrigin: "performance.now",
    note: "Wall-clock stages include network and frame waits. Nested stages overlap; durations must not be added together. Synchronous timings are elapsed time, not CPU samples. Worker stages do not block the main thread; their timestamps are aligned to the page time origin.",
    capacity: HISTORY_SIZE,
    slowOperationThresholdMilliseconds: SLOW_OPERATION_THRESHOLD_MS,
    slowOperationCapacity: SLOW_HISTORY_SIZE,
    slowOperations: [...slowHistory.slice(slowHistoryCursor), ...slowHistory.slice(0, slowHistoryCursor)]
      .map((entry) => ({ ...entry })),
    stages: [...history.slice(historyCursor), ...history.slice(0, historyCursor)]
      .map((entry) => ({ ...entry })),
    activeStages: [...active.values()].map((trace) => trace.snapshot(now, false)),
  };
}

function recordStage(entry: StageTiming): void {
  if (history.length < HISTORY_SIZE) history.push(entry);
  else {
    history[historyCursor] = entry;
    historyCursor = (historyCursor + 1) % HISTORY_SIZE;
  }
  const category = entry.executionThread === "worker" ? `worker.stage.${entry.stage}` : `streaming.stage.${entry.stage}`;
  creationStats.record(`${category}.ms`, entry.durationMilliseconds);
  if (entry.timingKind === "synchronous" && entry.durationMilliseconds > SLOW_OPERATION_THRESHOLD_MS) {
    if (slowHistory.length < SLOW_HISTORY_SIZE) slowHistory.push(entry);
    else {
      slowHistory[slowHistoryCursor] = entry;
      slowHistoryCursor = (slowHistoryCursor + 1) % SLOW_HISTORY_SIZE;
    }
    creationStats.recordSlowOperation(category, entry.durationMilliseconds);
  }
}

export function recordWorkerStages(
  label: string,
  stages: readonly { stage: string; startTimeMilliseconds: number; durationMilliseconds: number }[],
  workerTimeOrigin: number,
): void {
  const traceId = ++nextTraceId;
  const offset = workerTimeOrigin - performance.timeOrigin;
  for (const stage of stages) recordStage({ ...stage, traceId, label,
    startTimeMilliseconds: offset + stage.startTimeMilliseconds,
    executionThread: "worker", timingKind: "synchronous", completed: true });
}

/** Wall-clock timings include frame yields, network waits, and GPU waits. */
export class StreamingTrace {
  private readonly id = ++nextTraceId;
  private readonly started = performance.now();
  private stageStarted = this.started;
  private stageName = "starting";
  private finished = false;
  private readonly label: string;
  private timingKind: StageTiming["timingKind"];

  constructor(
    label: string,
    timingKind: StageTiming["timingKind"] = "wall-clock",
    stageName = "starting",
  ) {
    this.label = label;
    this.timingKind = timingKind;
    this.stageName = stageName;
    active.set(this.id, this);
  }

  snapshot(now: number, completed: boolean): StageTiming {
    return {
      traceId: this.id,
      label: this.label,
      stage: this.stageName,
      startTimeMilliseconds: this.stageStarted,
      durationMilliseconds: now - this.stageStarted,
      timingKind: this.timingKind,
      executionThread: "main",
      completed,
    };
  }

  stage(name: string, timingKind: StageTiming["timingKind"] = "wall-clock"): void {
    const now = performance.now();
    if (this.finished) return;
    const entry = this.snapshot(now, true);
    recordStage(entry);
    this.stageName = name;
    this.stageStarted = now;
    this.timingKind = timingKind;
  }

  finish(): void {
    if (this.finished) return;
    this.stage("finished");
    this.finished = true;
    active.delete(this.id);
    creationStats.record("streaming.finished.ms", performance.now() - this.started);
  }
}

export function traceStreamingSynchronous<T>(label: string, operation: () => T, stageName = "starting"): T {
  const trace = new StreamingTrace(label, "synchronous", stageName);
  try {
    return operation();
  } finally {
    trace.finish();
  }
}
