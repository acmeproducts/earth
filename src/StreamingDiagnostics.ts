import { creationStats } from "./CreationStats";

/** Wall-clock timings include frame yields, network waits, and GPU waits. */
export class StreamingTrace {
  private readonly started = performance.now();
  private stageStarted = this.started;
  private stageName = "starting";
  private finished = false;

  constructor(_label: string) {}

  stage(name: string): void {
    const now = performance.now();
    if (this.finished) return;
    creationStats.record(`streaming.stage.${this.stageName}.ms`, now - this.stageStarted);
    this.stageName = name;
    this.stageStarted = now;
  }

  finish(): void {
    if (this.finished) return;
    this.stage("finished");
    this.finished = true;
    creationStats.record("streaming.finished.ms", performance.now() - this.started);
  }
}
