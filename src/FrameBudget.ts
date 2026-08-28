const DEFAULT_BUDGET_MILLISECONDS = 2;
// Nothing is painted while the document is hidden, so slices only need to be
// short enough to keep network callbacks and input handlers responsive.
const HIDDEN_BUDGET_MILLISECONDS = 50;
// A visible document that stops delivering frames (occluded window, power
// saving) would otherwise park streamed work indefinitely.
const FRAME_STALL_TIMEOUT_MILLISECONDS = 1000;

export interface FrameBudgetYielder {
  (): Promise<void>;
  /** Starts the next slice after a render opportunity, regardless of elapsed time. */
  nextFrame(): Promise<void>;
}

/** True while the browser has no reason to paint, so frames stop arriving. */
export function documentIsHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

let framesStalled = false;
let stallProbePending = false;
let backgroundTaskChannel: MessageChannel | undefined;
const backgroundTasks: Array<() => void> = [];

/** Node keeps a process alive for a listening port; browsers ignore this. */
function holdBackgroundPort(port: MessagePort, held: boolean): void {
  const lifetime = port as MessagePort & { ref?: () => void; unref?: () => void };
  if (held) lifetime.ref?.();
  else lifetime.unref?.();
}

// Browsers clamp timers in hidden tabs to roughly one per second, which would
// make background initialization slower than useful. Message tasks keep running
// at full speed, so they carry the work while frames are unavailable.
function postBackgroundTask(task: () => void): void {
  if (typeof MessageChannel === "undefined") {
    setTimeout(task, 0);
    return;
  }
  if (!backgroundTaskChannel) {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const next = backgroundTasks.shift();
      if (backgroundTasks.length === 0) holdBackgroundPort(channel.port1, false);
      next?.();
    };
    backgroundTaskChannel = channel;
  }
  backgroundTasks.push(task);
  holdBackgroundPort(backgroundTaskChannel.port1, true);
  backgroundTaskChannel.port2.postMessage(null);
}

/** Keeps one frame request outstanding so work resumes frame pacing on return. */
function probeFrameDelivery(): void {
  if (stallProbePending || typeof requestAnimationFrame === "undefined") return;
  stallProbePending = true;
  requestAnimationFrame(() => {
    stallProbePending = false;
    framesStalled = false;
  });
}

/**
 * Resolves at the next render opportunity, or on a plain task when the document
 * is hidden and animation frames have stopped. Initialization streams itself
 * across frames, so a frame-only wait would suspend loading for as long as the
 * user looks at another tab.
 */
export function waitForNextFrame(): Promise<void> {
  if (documentIsHidden() || framesStalled) {
    probeFrameDelivery();
    return new Promise<void>((resolve) => { postBackgroundTask(resolve); });
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (stalled: boolean): void => {
      if (settled) return;
      settled = true;
      framesStalled = stalled;
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      resolve();
    };
    const onVisibilityChange = (): void => {
      // The pending frame will not fire again until the tab comes back.
      if (document.hidden) postBackgroundTask(() => finish(true));
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
      stallTimer = setTimeout(() => finish(true), FRAME_STALL_TIMEOUT_MILLISECONDS);
    }
    requestAnimationFrame(() => {
      // rAF callbacks run before painting. A timer lets all render callbacks
      // finish before streamed work starts consuming the following frame.
      setTimeout(() => finish(false), 0);
    });
  });
}

/** Cooperatively splits CPU-heavy scene construction across animation frames. */
export function createFrameBudgetYielder(
  budgetMilliseconds = DEFAULT_BUDGET_MILLISECONDS,
): FrameBudgetYielder {
  let frameStart = performance.now();

  const nextFrame = async (): Promise<void> => {
    await waitForNextFrame();
    frameStart = performance.now();
  };
  const yieldIfNeeded = async (): Promise<void> => {
    const budget = documentIsHidden()
      ? Math.max(budgetMilliseconds, HIDDEN_BUDGET_MILLISECONDS)
      : budgetMilliseconds;
    if (performance.now() - frameStart < budget) return;
    await nextFrame();
  };

  return Object.assign(yieldIfNeeded, { nextFrame });
}

/** Forces a frame boundary when the supplied callback supports it. */
export async function yieldToNextFrame(
  yieldControl?: (() => Promise<void>) | FrameBudgetYielder,
): Promise<void> {
  if (!yieldControl) return;
  const frameYielder = yieldControl as Partial<FrameBudgetYielder>;
  if (frameYielder.nextFrame) await frameYielder.nextFrame();
  else await yieldControl();
}
