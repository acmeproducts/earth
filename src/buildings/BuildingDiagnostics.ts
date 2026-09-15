import { creationStats } from "../diagnostics/CreationStats";

/** Periodic aggregate timings; stages are inclusive wall time, not GPU time.
 * Set globalThis.buildingTimingEnabled = false to disable building diagnostics.
 */
export class BuildingTrace {
  private readonly enabled = (globalThis as typeof globalThis & { buildingTimingEnabled?: boolean })
    .buildingTimingEnabled !== false;
  private readonly started = performance.now();
  private stageStarted = this.started;
  private stageName = "setup";
  private readonly timings = new Map<string, number>();

  stage(name: string): void {
    if (!this.enabled) return;
    const now = performance.now();
    const ms = now - this.stageStarted;
    this.timings.set(this.stageName, (this.timings.get(this.stageName) ?? 0) + ms);
    this.stageName = name;
    this.stageStarted = now;
  }

  static run<T>(label: string, work: (trace: BuildingTrace) => T, log = true): T {
    const trace = new BuildingTrace();
    let failed = true;
    try {
      const result = work(trace);
      failed = false;
      return result;
    } finally {
      if (log) trace.finish(label, failed);
    }
  }

  static async runAsync<T>(label: string, work: (trace: BuildingTrace) => Promise<T>): Promise<T> {
    const trace = new BuildingTrace();
    let failed = true;
    try {
      const result = await work(trace);
      failed = false;
      return result;
    } finally {
      trace.finish(label, failed);
    }
  }

  private finish(_label: string, failed: boolean): void {
    if (!this.enabled) return;
    this.stage("finished");
    const total = performance.now() - this.started;
    for (const [name, ms] of this.timings) creationStats.record(`building.stage.${name}.ms`, ms);
    creationStats.record(`building.${failed ? "failed" : "completed"}.ms`, total);
  }
}
