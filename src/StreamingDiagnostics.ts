/** Wall-clock timings include frame yields, network waits, and GPU waits. */
export class StreamingTrace {
  private static readonly active = new Set<StreamingTrace>();
  private readonly started = performance.now();
  private stageStarted = this.started;
  private stageName = "starting";
  private readonly timings: string[] = [];

  constructor(private readonly label: string) {
    StreamingTrace.active.add(this);
  }

  stage(name: string): void {
    const now = performance.now();
    this.timings.push(`${this.stageName}=${(now - this.stageStarted).toFixed(2)}ms`);
    this.stageName = name;
    this.stageStarted = now;
  }

  finish(): void {
    this.stage("finished");
    StreamingTrace.active.delete(this);
    console.log(`[Streaming timing] ${this.label} total=${Math.round(performance.now() - this.started)}ms ` +
      this.timings.join(" | "));
  }

  static logActive(): void {
    const now = performance.now();
    for (const trace of this.active) {
      console.log(`[Streaming active] ${trace.label} stage=${trace.stageName} ` +
        `stage-wait=${Math.round(now - trace.stageStarted)}ms total=${Math.round(now - trace.started)}ms`);
    }
  }
}
