/** One compact log per operation; stages are inclusive wall time, not GPU time.
 * Set globalThis.buildingTimingEnabled = false to disable building diagnostics.
 */
export class BuildingTrace {
  private readonly enabled = (globalThis as typeof globalThis & { buildingTimingEnabled?: boolean })
    .buildingTimingEnabled !== false;
  private readonly started = performance.now();
  private stageStarted = this.started;
  private stageName = "setup";
  private readonly timings: string[] = [];
  private slowest = { name: "setup", ms: 0 };

  stage(name: string): void {
    if (!this.enabled) return;
    const now = performance.now();
    const ms = now - this.stageStarted;
    this.timings.push(`${this.stageName}=${ms.toFixed(2)}ms`);
    if (ms > this.slowest.ms) this.slowest = { name: this.stageName, ms };
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

  private finish(label: string, failed: boolean): void {
    if (!this.enabled) return;
    this.stage("finished");
    const total = performance.now() - this.started;
    console.log(`[Building timing] ${label} status=${failed ? "error" : "ok"} ` +
      `total=${total.toFixed(2)}ms slowest=${this.slowest.name}:${this.slowest.ms.toFixed(2)}ms ` +
      this.timings.join(" | "));
  }
}
