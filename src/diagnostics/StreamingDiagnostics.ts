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
  if (entry.executionThread === "worker" && entry.label.startsWith("tile=")) accumulateTileStage(entry, "worker");
  // Tree fields and atlas captures trace themselves; their stages nest inside
  // the tile's tree stages.
  else if (entry.executionThread === "main" &&
    (entry.label.startsWith("trees ") || entry.label.startsWith("impostor "))) accumulateTileStage(entry, "nested");
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
  private readonly isTile: boolean;
  private readonly ownStages: StageTiming[] = [];

  constructor(
    label: string,
    timingKind: StageTiming["timingKind"] = "wall-clock",
    stageName = "starting",
  ) {
    this.label = label;
    this.timingKind = timingKind;
    this.stageName = stageName;
    this.isTile = label.startsWith("tile=");
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
    if (this.isTile) this.ownStages.push(entry);
    this.stageName = name;
    this.stageStarted = now;
    this.timingKind = timingKind;
  }

  finish(): void {
    if (this.finished) return;
    this.stage("finished");
    this.finished = true;
    active.delete(this.id);
    const total = performance.now() - this.started;
    creationStats.record("streaming.finished.ms", total);
    if (this.isTile) recordTileTiming(this.label, total, this.ownStages);
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

// ---------------------------------------------------------------------------
// Tile timing log
//
// Every tile build (`tile=<key> detail=<bool>` traces) logs one line with its
// wall-clock total, the main-thread blocking total, and its costliest stages.
// The same stages accumulate into a session aggregate so the dominant stage
// across many tiles can be read at a glance. Stage names are bounded; labels
// containing tile IDs are never used as keys.
// ---------------------------------------------------------------------------

export const TILE_TIMING_LOG_ENABLED = true;
const TILE_LOG_TOP_STAGES = 6;
const TILE_LOG_MINIMUM_STAGE_MS = 1;

type TileStageKind = StageTiming["timingKind"] | "worker" | "nested";

interface TileStageAggregate {
  stage: string;
  timingKind: TileStageKind;
  tiles: number;
  totalMilliseconds: number;
  maximumMilliseconds: number;
}

interface TileTimingTotals {
  tiles: number;
  wallClockMilliseconds: number;
  synchronousMilliseconds: number;
  maximumWallClockMilliseconds: number;
  maximumSynchronousMilliseconds: number;
}

const tileStageAggregates = new Map<string, TileStageAggregate>();
const tileTotals: Record<"terrain" | "detail", TileTimingTotals> = {
  terrain: emptyTotals(),
  detail: emptyTotals(),
};

function emptyTotals(): TileTimingTotals {
  return {
    tiles: 0, wallClockMilliseconds: 0, synchronousMilliseconds: 0,
    maximumWallClockMilliseconds: 0, maximumSynchronousMilliseconds: 0,
  };
}

/** Stage names may carry counts; collapse them so aggregate keys stay bounded. */
function normalizeStageName(stage: string): string {
  return stage.replace(/\d+/g, "*");
}

function accumulateTileStage(entry: StageTiming, timingKind: TileStageKind): void {
  const key = `${timingKind}:${normalizeStageName(entry.stage)}`;
  const aggregate = tileStageAggregates.get(key) ?? {
    stage: normalizeStageName(entry.stage), timingKind,
    tiles: 0, totalMilliseconds: 0, maximumMilliseconds: 0,
  };
  aggregate.tiles++;
  aggregate.totalMilliseconds += entry.durationMilliseconds;
  aggregate.maximumMilliseconds = Math.max(aggregate.maximumMilliseconds, entry.durationMilliseconds);
  tileStageAggregates.set(key, aggregate);
}

function recordTileTiming(label: string, totalMilliseconds: number, stages: readonly StageTiming[]): void {
  const kind = label.includes("detail=true") ? "detail" : "terrain";
  let synchronous = 0;
  for (const entry of stages) {
    if (entry.timingKind === "synchronous") synchronous += entry.durationMilliseconds;
    accumulateTileStage(entry, entry.timingKind);
  }
  const totals = tileTotals[kind];
  totals.tiles++;
  totals.wallClockMilliseconds += totalMilliseconds;
  totals.synchronousMilliseconds += synchronous;
  totals.maximumWallClockMilliseconds = Math.max(totals.maximumWallClockMilliseconds, totalMilliseconds);
  totals.maximumSynchronousMilliseconds = Math.max(totals.maximumSynchronousMilliseconds, synchronous);

  if (!TILE_TIMING_LOG_ENABLED) return;
  const top = [...stages]
    .filter((entry) => entry.durationMilliseconds >= TILE_LOG_MINIMUM_STAGE_MS)
    .sort((a, b) => b.durationMilliseconds - a.durationMilliseconds)
    .slice(0, TILE_LOG_TOP_STAGES)
    .map((entry) =>
      `${entry.stage} ${entry.durationMilliseconds.toFixed(0)}${entry.timingKind === "synchronous" ? "s" : ""}`)
    .join(" | ");
  console.log(
    `[Tile timing] ${label} total ${totalMilliseconds.toFixed(0)} ms, ` +
    `blocking ${synchronous.toFixed(0)} ms, ${stages.length} stages | ${top}`,
  );
}

/** Aggregated tile stage costs for the session, sorted by total wall-clock time. */
export function tileTimingSummary() {
  const stageRows = [...tileStageAggregates.values()]
    .sort((a, b) => b.totalMilliseconds - a.totalMilliseconds)
    .map((aggregate) => ({
      stage: aggregate.stage,
      kind: aggregate.timingKind === "synchronous" ? "blocking"
        : aggregate.timingKind === "worker" ? "worker"
        : aggregate.timingKind === "nested" ? "nested" : "wall-clock",
      tiles: aggregate.tiles,
      totalMs: Number(aggregate.totalMilliseconds.toFixed(1)),
      averageMs: Number((aggregate.totalMilliseconds / aggregate.tiles).toFixed(1)),
      maxMs: Number(aggregate.maximumMilliseconds.toFixed(1)),
    }));
  const totalsRows = (["terrain", "detail"] as const).map((kind) => {
    const totals = tileTotals[kind];
    const divisor = Math.max(1, totals.tiles);
    return {
      kind,
      tiles: totals.tiles,
      averageTotalMs: Number((totals.wallClockMilliseconds / divisor).toFixed(1)),
      maxTotalMs: Number(totals.maximumWallClockMilliseconds.toFixed(1)),
      averageBlockingMs: Number((totals.synchronousMilliseconds / divisor).toFixed(1)),
      maxBlockingMs: Number(totals.maximumSynchronousMilliseconds.toFixed(1)),
    };
  });
  return {
    note: "Tile stages nest inside 'terrain' and 'detail (...)' parents and the parents' own rows are near zero. Wall-clock rows include network and frame waits; blocking rows are elapsed main-thread time; worker rows run off the main thread and nest inside worker wait stages. Rows must not be summed across kinds.",
    tiles: totalsRows,
    stages: stageRows,
  };
}

/** Prints the session aggregate as console tables. */
export function logTileTimingSummary(): void {
  const summary = tileTimingSummary();
  const tileCount = summary.tiles.reduce((count, row) => count + row.tiles, 0);
  console.log(`[Tile timing summary] ${tileCount} tile builds this session`);
  if (!tileCount) return;
  console.table(summary.tiles);
  console.table(summary.stages);
}

/** Test support. */
export function resetTileTimingSummary(): void {
  tileStageAggregates.clear();
  tileTotals.terrain = emptyTotals();
  tileTotals.detail = emptyTotals();
}
