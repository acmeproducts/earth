import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("./ts-extension-resolver.mjs", import.meta.url);
const { createFrameBudgetYielder } = await import("../src/FrameBudget.ts");

test("frame budget yields after animation callbacks before resuming work", async () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  let animationCallback;
  globalThis.requestAnimationFrame = (callback) => {
    animationCallback = callback;
    return 1;
  };

  try {
    const yielder = createFrameBudgetYielder(0);
    let resumed = false;
    const pending = yielder().then(() => { resumed = true; });

    assert.equal(resumed, false);
    assert.equal(typeof animationCallback, "function");
    animationCallback(0);
    await Promise.resolve();
    assert.equal(resumed, false, "work must not resume inside the animation callback turn");

    await pending;
    assert.equal(resumed, true);
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});

test("frame budget exposes an explicit boundary for large indivisible work", () => {
  const yielder = createFrameBudgetYielder();
  assert.equal(typeof yielder.nextFrame, "function");
});
