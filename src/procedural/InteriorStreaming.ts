import type { Scene } from "@babylonjs/core";
import { creationStats } from "../diagnostics/CreationStats";
import { waitForNextFrame } from "../diagnostics/FrameBudget";
import { BUILDING_INTERIOR_LOAD_DISTANCE_METERS } from "./BuildingRendererConstants";

export const INTERIOR_WORK_BUDGET_MS = 2;
// Time is the normal limit; this guard also bounds work under a frozen/coarse clock.
export const INTERIOR_STEPS_PER_FRAME = 256;
export const INTERIOR_MERGE_VERTEX_BUDGET = 4096;
const FOCUS_HYSTERESIS_METERS = 0.5;

export interface InteriorBuildJob {
  label: string;
  steps: Generator<string, void, void>;
  valid: () => boolean;
  /** Current distance in metres; evaluated again before each frame's work. */
  priority?: () => number;
  background?: boolean;
  blocksExterior?: () => boolean;
  complete: () => void;
  cancel: (retry: boolean) => void;
}

class BuildProgress {
  started?: number;
  cpuMs = 0;
  maxStepMs = 0;
  steps = 0;
  stage = "queued";
  readonly job: InteriorBuildJob;
  constructor(job: InteriorBuildJob) { this.job = job; }
}

/** One cooperative budget; paused generators and their timing statistics survive focus changes. */
class InteriorBuildQueue {
  private readonly jobs: BuildProgress[] = [];
  private current?: BuildProgress;
  private lastFrame = -1;
  private foregroundSlices = 0;

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

  hasNearbyWork(): boolean {
    return this.jobs.some(({ job }) => !job.background && job.valid() && (job.blocksExterior?.() ?? true) &&
      (job.priority?.() ?? Infinity) <= BUILDING_INTERIOR_LOAD_DISTANCE_METERS);
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
    // Give furnishings one bounded slice in four even while structures keep arriving.
    const serviceBackground = this.foregroundSlices >= 3 && this.jobs.some(({ job }) => job.background);
    const rank = (entry: BuildProgress): number => Number(!!entry.job.background !== serviceBackground);
    let nearest = Infinity;
    let currentDistance = Infinity;
    for (const entry of this.jobs) {
      const distance = entry.job.priority?.() ?? 0;
      if (entry === this.current) currentDistance = distance;
      if (!selected || rank(entry) < rank(selected) ||
          (!!entry.job.background === !!selected.job.background && distance < nearest)) {
        selected = entry;
        nearest = distance;
      }
    }
    // Hysteresis applies only to an already active build, not initial queue ordering.
    if (this.current && selected && !!this.current.job.background === !!selected.job.background &&
        currentDistance <= nearest + FOCUS_HYSTERESIS_METERS) selected = this.current;
    if (!selected) return;
    this.foregroundSlices = selected.job.background ? 0 : this.foregroundSlices + 1;
    const previous = this.current;
    this.current = selected;
    const entry = selected;
    const job = entry.job;
    const now = performance.now();
    if (previous && previous !== entry) this.record("focusChanges");
    if (entry.started === undefined) {
      entry.started = now;
      this.record("started");
    }
    const start = performance.now();
    let done = false;
    let failed = false;
    try {
      for (let count = 0; count < INTERIOR_STEPS_PER_FRAME; count++) {
        const stepStart = performance.now();
        const next = job.steps.next();
        const stepMs = performance.now() - stepStart;
        const stage = next.done ? "finish" : next.value;
        entry.maxStepMs = Math.max(entry.maxStepMs, stepMs);
        entry.stage = stage;
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
      this.record("slice.ms", elapsed);
    }
    if (done || failed) {
      this.log(entry, failed ? "failed" : "complete");
      this.remove(entry);
    }
  }

  private record(name: string, value = 1): void {
    if ((globalThis as typeof globalThis & { buildingTimingEnabled?: boolean }).buildingTimingEnabled === false) return;
    creationStats.record(`interior.${name}`, value);
  }

  private log(entry: BuildProgress, status: string): void {
    this.record(status);
    this.record("wall.ms", performance.now() - (entry.started ?? performance.now()));
    this.record("cpu.ms", entry.cpuMs);
    this.record("steps", entry.steps);
    this.record("maxStep.ms", entry.maxStepMs);
  }
}

const queues = new WeakMap<Scene, InteriorBuildQueue>();

/** Give urgent floor structures a bounded head start over more exterior construction. */
export async function yieldToNearbyInteriors(scene: Scene, isCancelled?: () => boolean): Promise<void> {
  // Reserve most opportunities for urgent interiors without starving exterior streaming.
  for (let frames = 0; frames < 2 && !isCancelled?.() && queues.get(scene)?.hasNearbyWork(); frames++) {
    const frame = scene.getFrameId();
    await waitForNextFrame();
    // Interiors advance on rendered frames. Do not park background loading when rendering stops.
    if (scene.getFrameId() === frame) break;
  }
}

export function enqueueInteriorBuild(scene: Scene, job: InteriorBuildJob): () => void {
  let queue = queues.get(scene);
  if (!queue) { queue = new InteriorBuildQueue(scene); queues.set(scene, queue); }
  return queue.enqueue(job);
}
