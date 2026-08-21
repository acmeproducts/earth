const DEFAULT_BUDGET_MILLISECONDS = 6;

/** Cooperatively splits CPU-heavy scene construction across animation frames. */
export function createFrameBudgetYielder(
  budgetMilliseconds = DEFAULT_BUDGET_MILLISECONDS,
): () => Promise<void> {
  let frameStart = performance.now();

  return async (): Promise<void> => {
    if (performance.now() - frameStart < budgetMilliseconds) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    frameStart = performance.now();
  };
}
