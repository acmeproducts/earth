const DEFAULT_BUDGET_MILLISECONDS = 2;

export interface FrameBudgetYielder {
  (): Promise<void>;
  /** Starts the next slice after a render opportunity, regardless of elapsed time. */
  nextFrame(): Promise<void>;
}

function waitForNextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      // rAF callbacks run before painting. A timer lets all render callbacks
      // finish before streamed work starts consuming the following frame.
      setTimeout(resolve, 0);
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
    if (performance.now() - frameStart < budgetMilliseconds) return;
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
