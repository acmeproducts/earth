import type { Scene } from "@babylonjs/core";

export const INTERIOR_WORK_BUDGET_MS = 2;
export const INTERIOR_STEPS_PER_FRAME = 8;
export const INTERIOR_MERGE_VERTEX_BUDGET = 4096;
const PROGRESS_INTERVAL_MS = 2000;
const FOCUS_HYSTERESIS_METERS = 0.5;

export interface InteriorBuildJob {
  label: string;
  steps: Generator<string, void, void>;
  valid: () => boolean;
  /** Current distance in metres; evaluated again before each frame's work. */
  priority?: () => number;
  complete: () => void;
  cancel: (retry: boolean) => void;
}

class BuildProgress {
  started?: number;
  lastProgress = 0;
  cpuMs = 0;
  maxSliceMs = 0;
  maxStepMs = 0;
  maxStepStage = "none";
  slices = 0;
  steps = 0;
  stage = "queued";
  readonly stages = new Map<string, number>();
  readonly job: InteriorBuildJob;
  constructor(job: InteriorBuildJob) { this.job = job; }
}

/** One cooperative budget; paused generators and their timing statistics survive focus changes. */
class InteriorBuildQueue {
  private readonly jobs: BuildProgress[] = [];
  private current?: BuildProgress;
  private lastFrame = -1;
  private lastFocusLog = -Infinity;
  private focusChanges = 0;

  constructor(scene: Scene) {
    scene.onAfterRenderObservable.add(() => this.advance(scene.getFrameId()));
    scene.onDisposeObservable.addOnce(() => {
      for (const entry of [...this.jobs]) this.cancel(entry, false);
    });
  }

  enqueue(job: InteriorBuildJob): () => void {
    const entry = new BuildProgress(job);
    this.jobs.push(entry);
    return () => this.cancel(entry);
  }

  private remove(entry: BuildProgress): boolean {
    const index = this.jobs.indexOf(entry);
    if (index < 0) return false;
    this.jobs.splice(index, 1);
    if (this.current === entry) this.current = undefined;
    return true;
  }

  private cancel(entry: BuildProgress, retry = true): void {
    if (!this.remove(entry)) return;
    try { entry.job.steps.return(); } finally { entry.job.cancel(retry); }
    if (retry && entry.started !== undefined) this.log(entry, "cancelled");
  }

  private advance(frame: number): void {
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    for (const entry of [...this.jobs]) {
      if (!entry.job.valid()) this.cancel(entry);
    }
    let selected: BuildProgress | undefined;
    let nearest = Infinity;
    let currentDistance = Infinity;
    for (const entry of this.jobs) {
      const distance = entry.job.priority?.() ?? 0;
      if (entry === this.current) currentDistance = distance;
      if (!selected || distance < nearest) {
        selected = entry;
        nearest = distance;
      }
    }
    // Hysteresis applies only to an already active build, not initial queue ordering.
    if (this.current && currentDistance <= nearest + FOCUS_HYSTERESIS_METERS) selected = this.current;
    if (!selected) return;
    const previous = this.current;
    this.current = selected;
    const entry = selected;
    const job = entry.job;
    const now = performance.now();
    if (previous && previous !== entry) this.focusChanges++;
    if (entry.started === undefined) {
      entry.started = entry.lastProgress = now;
      this.log(entry, "started");
    } else if (previous !== entry && now - this.lastFocusLog >= PROGRESS_INTERVAL_MS) {
      this.log(entry, "resumed");
      this.lastFocusLog = now;
    }
    if (previous !== entry) entry.lastProgress = now;
    const start = performance.now();
    let done = false;
    let failed = false;
    try {
      for (let count = 0; count < INTERIOR_STEPS_PER_FRAME; count++) {
        const stepStart = performance.now();
        const next = job.steps.next();
        const stepMs = performance.now() - stepStart;
        const stage = next.done ? "finish" : next.value;
        if (stepMs > entry.maxStepMs) { entry.maxStepMs = stepMs; entry.maxStepStage = stage; }
        entry.stage = stage;
        entry.stages.set(stage, (entry.stages.get(stage) ?? 0) + stepMs);
        entry.steps++;
        if (next.done) {
          done = true;
          job.complete();
          break;
        }
        if (performance.now() - start >= INTERIOR_WORK_BUDGET_MS) break;
      }
    } catch (error) {
      failed = true;
      console.warn(`[Building stream] ${job.label} failed after ${entry.stage}`, error);
      this.cancel(entry, false);
    } finally {
      const elapsed = performance.now() - start;
      entry.cpuMs += elapsed;
      entry.maxSliceMs = Math.max(entry.maxSliceMs, elapsed);
      entry.slices++;
    }
    if (done || failed) {
      this.log(entry, failed ? "failed" : "complete");
      this.remove(entry);
    } else if (performance.now() - entry.lastProgress >= PROGRESS_INTERVAL_MS) {
      this.log(entry, "progress");
      entry.lastProgress = performance.now();
    }
  }

  private log(entry: BuildProgress, status: string): void {
    if ((globalThis as typeof globalThis & { buildingTimingEnabled?: boolean }).buildingTimingEnabled === false) return;
    const summary = status === "complete" || status === "failed"
      ? ` stages=${[...entry.stages].map(([name, ms]) => `${name}:${ms.toFixed(1)}ms`).join(", ")}` : "";
    console.log(`[Building stream] ${entry.job.label} ${status} stage=${entry.stage} ` +
      `wall=${(performance.now() - (entry.started ?? performance.now())).toFixed(0)}ms cpu=${entry.cpuMs.toFixed(1)}ms ` +
      `frames=${entry.slices} steps=${entry.steps} maxSlice=${entry.maxSliceMs.toFixed(2)}ms ` +
      `worstStep=${entry.maxStepStage}:${entry.maxStepMs.toFixed(2)}ms ` +
      `distance=${(entry.job.priority?.() ?? 0).toFixed(1)}m focusChanges=${this.focusChanges} ` +
      `queued=${Math.max(0, this.jobs.length - 1)}${summary}`);
  }
}

const queues = new WeakMap<Scene, InteriorBuildQueue>();
export function enqueueInteriorBuild(scene: Scene, job: InteriorBuildJob): () => void {
  let queue = queues.get(scene);
  if (!queue) { queue = new InteriorBuildQueue(scene); queues.set(scene, queue); }
  return queue.enqueue(job);
}
