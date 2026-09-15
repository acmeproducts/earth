import { creationStats } from "./CreationStats";

const HISTORY_SIZE = 512;
interface StageTiming {
  traceId: number;
  label: string;
  stage: string;
  startTimeMilliseconds: number;
  durationMilliseconds: number;
  timingKind: "wall-clock" | "synchronous";
  completed: boolean;
}
const history: StageTiming[] = [];
const active = new Map<number, StreamingTrace>();
let nextTraceId = 0;
let historyCursor = 0;

export function streamingDiagnosticsSnapshot() {
  const now = performance.now();
  return {
    timeOrigin: "performance.now",
    note: "Wall-clock stages include network and frame waits. Nested stages overlap; durations must not be added together. Synchronous timings are elapsed time, not CPU samples.",
    capacity: HISTORY_SIZE,
    stages: [...history.slice(historyCursor), ...history.slice(0, historyCursor)]
      .map((entry) => ({ ...entry })),
    activeStages: [...active.values()].map((trace) => trace.snapshot(now, false)),
  };
}

/** Wall-clock timings include frame yields, network waits, and GPU waits. */
export class StreamingTrace {
  private readonly id = ++nextTraceId;
  private readonly started = performance.now();
  private stageStarted = this.started;
  private stageName = "starting";
  private finished = false;
  private readonly label: string;
  private readonly timingKind: StageTiming["timingKind"];

  constructor(
    label: string,
    timingKind: StageTiming["timingKind"] = "wall-clock",
  ) {
    this.label = label;
    this.timingKind = timingKind;
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
      completed,
    };
  }

  stage(name: string): void {
    const now = performance.now();
    if (this.finished) return;
    const entry = this.snapshot(now, true);
    if (history.length < HISTORY_SIZE) history.push(entry);
    else {
      history[historyCursor] = entry;
      historyCursor = (historyCursor + 1) % HISTORY_SIZE;
    }
    creationStats.record(`streaming.stage.${this.stageName}.ms`, now - this.stageStarted);
    this.stageName = name;
    this.stageStarted = now;
  }

  finish(): void {
    if (this.finished) return;
    this.stage("finished");
    this.finished = true;
    active.delete(this.id);
    creationStats.record("streaming.finished.ms", performance.now() - this.started);
  }
}

export function traceStreamingSynchronous<T>(label: string, operation: () => T): T {
  const trace = new StreamingTrace(label, "synchronous");
  try {
    return operation();
  } finally {
    trace.finish();
  }
}
