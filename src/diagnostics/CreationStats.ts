export const CREATION_STATS_INTERVAL_MS = 10_000;
export const SLOW_OPERATION_THRESHOLD_MS = 32;
const SLOW_OPERATION_HISTORY_SIZE = 256;

interface SlowOperation {
  category: string;
  milliseconds: number;
  recordedAtMilliseconds: number;
}

interface Measurement {
  count: number;
  total: number;
  min: number;
  max: number;
}

/** Bounded category names only: never use tile IDs or building labels as keys. */
class CreationStats {
  private readonly measurements = new Map<string, Measurement>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly slowOperations: SlowOperation[] = [];

  /** For synchronous elapsed timings only, not network or scheduled waits. */
  recordSlowOperation(category: string, milliseconds: number): void {
    if (Number.isFinite(milliseconds) && milliseconds > SLOW_OPERATION_THRESHOLD_MS) {
      if (this.slowOperations.length === SLOW_OPERATION_HISTORY_SIZE) this.slowOperations.shift();
      this.slowOperations.push({ category, milliseconds, recordedAtMilliseconds: performance.now() });
      this.record(`slow.${category}.ms`, milliseconds);
    }
  }

  slowOperationsSnapshot() {
    const groups = new Map<string, {
      category: string;
      count: number;
      maximumMilliseconds: number;
      latestMilliseconds: number;
      recordedAtMilliseconds: number;
    }>();
    for (const entry of this.slowOperations) {
      const previous = groups.get(entry.category);
      groups.set(entry.category, {
        category: entry.category,
        count: (previous?.count ?? 0) + 1,
        maximumMilliseconds: Math.max(previous?.maximumMilliseconds ?? 0, entry.milliseconds),
        latestMilliseconds: entry.milliseconds,
        recordedAtMilliseconds: entry.recordedAtMilliseconds,
      });
    }
    return {
      capacity: SLOW_OPERATION_HISTORY_SIZE,
      sampleCount: this.slowOperations.length,
      operations: [...groups.values()].sort((a, b) =>
        b.maximumMilliseconds - a.maximumMilliseconds || b.recordedAtMilliseconds - a.recordedAtMilliseconds),
    };
  }

  record(category: string, value = 1): void {
    const stat = this.measurements.get(category) ?? { count: 0, total: 0, min: Infinity, max: -Infinity };
    stat.count++;
    stat.total += value;
    stat.min = Math.min(stat.min, value);
    stat.max = Math.max(stat.max, value);
    this.measurements.set(category, stat);
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), CREATION_STATS_INTERVAL_MS);
      // Diagnostics should not keep command-line benchmarks alive.
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.measurements.size) return;
    const stats = Object.fromEntries([...this.measurements].map(([name, stat]) => [name, {
      count: stat.count,
      total: Number(stat.total.toFixed(2)),
      average: Number((stat.total / stat.count).toFixed(2)),
      min: Number(stat.min.toFixed(2)),
      max: Number(stat.max.toFixed(2)),
    }]));
    this.measurements.clear();
    console.log(`[Creation stats / ${CREATION_STATS_INTERVAL_MS / 1000}s]`, stats);
  }
}

export const creationStats = new CreationStats();
