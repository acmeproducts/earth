import assert from "node:assert/strict";
import test from "node:test";

const { createFrameBudgetYielder, waitForNextFrame } = await import("../src/FrameBudget.ts");

function stubDocument(hidden, focused = true) {
  const listeners = new Set();
  globalThis.document = {
    hidden,
    hasFocus: () => focused,
    addEventListener: (type, listener) => { if (type === "visibilitychange") listeners.add(listener); },
    removeEventListener: (type, listener) => { listeners.delete(listener); },
  };
  return {
    hide() {
      globalThis.document.hidden = true;
      listeners.forEach((listener) => listener());
    },
    setFocused(value) { focused = value; },
    restore() { delete globalThis.document; },
  };
}

function burnMilliseconds(milliseconds) {
  const start = performance.now();
  while (performance.now() - start < milliseconds);
}


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

test("unfocused documents keep streaming without waiting for animation frames", async () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  let animationCallback;
  let animationRequests = 0;
  globalThis.requestAnimationFrame = (callback) => {
    animationRequests++;
    animationCallback = callback;
    return 1;
  };
  const documentStub = stubDocument(false, false);

  try {
    const yielder = createFrameBudgetYielder(0);
    await yielder.nextFrame();
    assert.equal(animationRequests, 1, "only the probe that notices focus returning");
    documentStub.setFocused(true);
    animationCallback(0);
  } finally {
    documentStub.restore();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});

test("hidden documents keep streaming without waiting for animation frames", async () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  let animationRequests = 0;
  globalThis.requestAnimationFrame = () => { animationRequests++; return 1; };
  const documentStub = stubDocument(true);

  try {
    const yielder = createFrameBudgetYielder(0);
    // No animation callback is ever invoked, yet the slice still completes.
    await yielder.nextFrame();
    assert.equal(animationRequests, 1, "only the probe that notices the tab returning");
  } finally {
    documentStub.restore();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});

test("hidden documents spend a longer slice between yields", async () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  let animationCallback;
  let animationRequests = 0;
  globalThis.requestAnimationFrame = (callback) => {
    animationRequests++;
    animationCallback = callback;
    return 1;
  };
  const documentStub = stubDocument(true);

  try {
    const yielder = createFrameBudgetYielder(2);
    burnMilliseconds(5);
    await yielder();
    assert.equal(animationRequests, 0, "a 5ms slice stays inside the hidden budget");

    globalThis.document.hidden = false;
    burnMilliseconds(5);
    const pending = yielder();
    assert.equal(animationRequests, 1, "the same slice overruns the visible budget");
    animationCallback(0);
    await pending;
  } finally {
    documentStub.restore();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});

test("hiding the tab releases work already waiting on an animation frame", async () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  const documentStub = stubDocument(false);

  try {
    let resumed = false;
    const pending = waitForNextFrame().then(() => { resumed = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(resumed, false, "the frame that would resume the work never arrives");

    documentStub.hide();
    await pending;
    assert.equal(resumed, true);
  } finally {
    documentStub.restore();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});
