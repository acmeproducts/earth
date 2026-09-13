import type { Scene } from "@babylonjs/core";

export const INTERIOR_WORK_BUDGET_MS = 2;
export const INTERIOR_STEPS_PER_FRAME = 8;
export const INTERIOR_MERGE_VERTEX_BUDGET = 4096;
const PROGRESS_INTERVAL_MS = 2000;

export interface InteriorBuildJob {
  label: string;
  steps: Generator<string, void, void>;
  valid: () => boolean;
  complete: () => void;
  cancel: (retry: boolean) => void;
}

/** One cooperative work budget shared by every building in a scene. */
class InteriorBuildQueue {
  private readonly jobs: InteriorBuildJob[] = [];
  private current?: InteriorBuildJob;
  private lastFrame = -1;
  private started = 0;
  private lastProgress = 0;
  private cpuMs = 0;
  private maxSliceMs = 0;
  private maxStepMs = 0;
  private maxStepStage = "none";
  private slices = 0;
  private steps = 0;
  private stage = "queued";
  private readonly stages = new Map<string, number>();

  constructor(scene: Scene) {
    scene.onAfterRenderObservable.add(() => this.advance(scene.getFrameId()));
    scene.onDisposeObservable.addOnce(() => {
      const current = this.current;
      this.current = undefined;
      if (current) this.cancel(current, false);
      for (const job of this.jobs.splice(0)) this.cancel(job, false);
    });
  }

  enqueue(job: InteriorBuildJob): () => void {
    this.jobs.push(job);
    return () => {
      if (this.current === job) {
        this.cancel(job);
        this.current = undefined;
      } else {
        const index = this.jobs.indexOf(job);
        if (index >= 0) {
          this.jobs.splice(index, 1);
          this.cancel(job);
        }
      }
    };
  }

  private cancel(job: InteriorBuildJob, retry = true): void {
    try { job.steps.return(); } finally { job.cancel(retry); }
    if (retry && job === this.current) this.log("cancelled");
  }

  private advance(frame: number): void {
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    if (!this.current) {
      // Invalid queued jobs do no geometry work.
      const next = this.jobs.shift();
      if (!next) return;
      if (!next.valid()) { this.cancel(next); return; }
      this.current = next;
      this.started = this.lastProgress = performance.now();
      this.cpuMs = this.maxSliceMs = this.slices = this.steps = 0;
      this.maxStepMs = 0;
      this.maxStepStage = "none";
      this.stage = "starting";
      this.stages.clear();
      this.log("started");
    }
    const job = this.current;
    if (!job.valid()) { this.cancel(job); this.current = undefined; return; }
    const start = performance.now();
    let done = false;
    let failed = false;
    try {
      for (let count = 0; count < INTERIOR_STEPS_PER_FRAME; count++) {
        const stepStart = performance.now();
        const next = job.steps.next();
        const stepMs = performance.now() - stepStart;
        const stage = next.done ? "finish" : next.value;
        if (stepMs > this.maxStepMs) { this.maxStepMs = stepMs; this.maxStepStage = stage; }
        this.stage = stage;
        this.stages.set(stage, (this.stages.get(stage) ?? 0) + stepMs);
        this.steps++;
        if (next.done) {
          done = true;
          job.complete();
          break;
        }
        if (performance.now() - start >= INTERIOR_WORK_BUDGET_MS) break;
      }
    } catch (error) {
      failed = true;
      console.warn(`[Building stream] ${job.label} failed after ${this.stage}`, error);
      this.cancel(job, false);
    } finally {
      const elapsed = performance.now() - start;
      this.cpuMs += elapsed;
      this.maxSliceMs = Math.max(this.maxSliceMs, elapsed);
      this.slices++;
    }
    if (done || failed) {
      this.log(failed ? "failed" : "complete");
      this.current = undefined;
    } else if (performance.now() - this.lastProgress >= PROGRESS_INTERVAL_MS) {
      this.log("progress");
      this.lastProgress = performance.now();
    }
  }

  private log(status: string): void {
    if ((globalThis as typeof globalThis & { buildingTimingEnabled?: boolean }).buildingTimingEnabled === false) return;
    const summary = status === "complete" || status === "failed"
      ? ` stages=${[...this.stages].map(([name, ms]) => `${name}:${ms.toFixed(1)}ms`).join(", ")}` : "";
    console.log(`[Building stream] ${this.current?.label} ${status} stage=${this.stage} ` +
      `wall=${(performance.now() - this.started).toFixed(0)}ms cpu=${this.cpuMs.toFixed(1)}ms ` +
      `frames=${this.slices} steps=${this.steps} maxSlice=${this.maxSliceMs.toFixed(2)}ms ` +
      `worstStep=${this.maxStepStage}:${this.maxStepMs.toFixed(2)}ms ` +
      `queued=${this.jobs.length}${summary}`);
  }
}

const queues = new WeakMap<Scene, InteriorBuildQueue>();
export function enqueueInteriorBuild(scene: Scene, job: InteriorBuildJob): () => void {
  let queue = queues.get(scene);
  if (!queue) { queue = new InteriorBuildQueue(scene); queues.set(scene, queue); }
  return queue.enqueue(job);
}
