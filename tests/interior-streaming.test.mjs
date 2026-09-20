import assert from "node:assert/strict";
import test from "node:test";
import { Observable } from "@babylonjs/core";
import { enqueueInteriorBuild, INTERIOR_STEPS_PER_FRAME, yieldToNearbyInteriors } from "../src/procedural/InteriorStreaming.ts";
import { creationStats } from "../src/diagnostics/CreationStats.ts";

function fakeScene() {
  return { frame: 0, getFrameId() { return this.frame; },
    onAfterRenderObservable: new Observable(), onDisposeObservable: new Observable() };
}
function tick(scene) {
  scene.frame++;
  scene.onAfterRenderObservable.notifyObservers(scene);
}

function mockAnimationFrame(t, callback) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  globalThis.requestAnimationFrame = callback;
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "requestAnimationFrame", original);
    else delete globalThis.requestAnimationFrame;
  });
}

test("exteriors wait for nearby interiors and resume after completion", async (t) => {
  t.mock.method(performance, "now", () => 0);
  const scene = fakeScene();
  let completed = false, frames = 0;
  mockAnimationFrame(t, (callback) => {
    frames++;
    tick(scene);
    callback();
  });
  enqueueInteriorBuild(scene, {
    label: "nearby", priority: () => 18, valid: () => true,
    steps: (function* () { for (let i = 0; i < INTERIOR_STEPS_PER_FRAME + 1; i++) yield "geometry"; })(),
    complete: () => { completed = true; }, cancel: () => {},
  });
  await yieldToNearbyInteriors(scene);
  assert.equal(completed, true);
  assert.equal(frames, 2);
});

test("exterior priority responds to movement, invalidation, cancellation and stopped rendering", async (t) => {
  const scene = fakeScene();
  let distance = 19, valid = true, frames = 0;
  let onFrame = () => {};
  mockAnimationFrame(t, (callback) => {
    frames++;
    onFrame();
    callback();
  });
  enqueueInteriorBuild(scene, {
    label: "moving", priority: () => distance, valid: () => valid,
    steps: (function* () { while (true) yield "geometry"; })(),
    complete: () => {}, cancel: () => {},
  });
  await yieldToNearbyInteriors(scene);
  assert.equal(frames, 0, "resident work beyond the load radius does not block exteriors");
  distance = 1;
  valid = false;
  await yieldToNearbyInteriors(scene);
  valid = true;
  await yieldToNearbyInteriors(scene, () => true);
  assert.equal(frames, 0, "invalid jobs and cancelled callers do not wait");
  onFrame = () => { tick(scene); distance = 20; };
  await yieldToNearbyInteriors(scene);
  assert.equal(frames, 1, "moving away releases exterior work");
  distance = 1;
  onFrame = () => {};
  await yieldToNearbyInteriors(scene);
  assert.equal(frames, 2, "stopped rendering does not deadlock exterior loading");
  scene.onDisposeObservable.notifyObservers(scene);
});

test("nearest building takes priority and moving the player pauses and resumes existing work", (t) => {
  t.mock.method(performance, "now", () => 0);
  const logs = [];
  t.mock.method(console, "log", (message) => logs.push(message));
  const scene = fakeScene();
  const distances = [10, 2], work = [0, 0], created = [0, 0];
  const complete = [];
  for (let id = 0; id < 2; id++) enqueueInteriorBuild(scene, {
    label: `priority-${id}`, priority: () => distances[id], valid: () => true,
    steps: (function* () { created[id]++; for (let i = 0; i < INTERIOR_STEPS_PER_FRAME * 3 + 6; i++) { work[id]++; yield "geometry"; } })(),
    complete: () => complete.push(id), cancel: () => assert.fail("Focus changes must not discard work"),
  });
  tick(scene);
  assert.deepEqual(work, [0, INTERIOR_STEPS_PER_FRAME], "nearest beats enqueue order");
  distances[0] = 1; distances[1] = 10;
  tick(scene);
  assert.deepEqual(work, [INTERIOR_STEPS_PER_FRAME, INTERIOR_STEPS_PER_FRAME], "switch without advancing the previous building");
  distances[0] = 10; distances[1] = 1;
  tick(scene);
  assert.deepEqual(work, [INTERIOR_STEPS_PER_FRAME, INTERIOR_STEPS_PER_FRAME * 2], "resume from saved progress");
  for (let frame = 0; frame < 10; frame++) tick(scene);
  assert.deepEqual(work, [INTERIOR_STEPS_PER_FRAME * 3 + 6, INTERIOR_STEPS_PER_FRAME * 3 + 6]);
  assert.deepEqual(created, [1, 1]);
  assert.deepEqual(complete, [1, 0]);
  assert.equal(logs.length, 0, "focus changes do not log per building");
});

test("tiny distance changes do not thrash focus between nearly tied buildings", (t) => {
  t.mock.method(performance, "now", () => 0);
  t.mock.method(console, "log", () => {});
  const scene = fakeScene(), work = [0, 0], distances = [2, 4];
  for (let id = 0; id < 2; id++) enqueueInteriorBuild(scene, {
    label: `${id}`, priority: () => distances[id], valid: () => true,
    steps: (function* () { while (true) { work[id]++; yield "geometry"; } })(),
    complete: () => {}, cancel: () => {},
  });
  tick(scene);
  distances[1] = 1.8;
  tick(scene);
  assert.deepEqual(work, [INTERIOR_STEPS_PER_FRAME * 2, 0]);
  distances[1] = 1;
  tick(scene);
  assert.deepEqual(work, [INTERIOR_STEPS_PER_FRAME * 2, INTERIOR_STEPS_PER_FRAME]);
  scene.onDisposeObservable.notifyObservers(scene);
});

test("interior queue shares one budget, limits steps, and never advances twice in one frame", (t) => {
  t.mock.method(performance, "now", () => 0);
  t.mock.method(console, "log", () => {});
  const scene = fakeScene();
  const work = [0, 0], completed = [];
  for (let id = 0; id < 2; id++) enqueueInteriorBuild(scene, {
    label: `job-${id}`, valid: () => true,
    steps: (function* () { for (let i = 0; i < INTERIOR_STEPS_PER_FRAME * 2 + 4; i++) { work[id]++; yield "geometry"; } })(),
    complete: () => completed.push(id), cancel: () => assert.fail("Unexpected cancellation"),
  });
  tick(scene);
  assert.equal(work[0], INTERIOR_STEPS_PER_FRAME);
  assert.equal(work[1], 0);
  scene.onAfterRenderObservable.notifyObservers(scene);
  assert.equal(work[0], INTERIOR_STEPS_PER_FRAME);
  for (let i = 0; i < 10; i++) tick(scene);
  assert.deepEqual(work, [INTERIOR_STEPS_PER_FRAME * 2 + 4, INTERIOR_STEPS_PER_FRAME * 2 + 4]);
  assert.deepEqual(completed, [0, 1]);
});

test("time budget stops a slice and completion contributes aggregate timings", (t) => {
  creationStats.flush();
  let clock = 0, work = 0;
  const logs = [];
  t.mock.method(performance, "now", () => clock);
  t.mock.method(console, "log", (message) => logs.push(message));
  const scene = fakeScene();
  enqueueInteriorBuild(scene, {
    label: "timed", valid: () => true,
    steps: (function* () { for (let i = 0; i < 8; i++) { clock += 3; work++; yield "geometry"; } })(),
    complete: () => {}, cancel: () => assert.fail("Unexpected cancellation"),
  });
  tick(scene);
  assert.equal(work, 1, "a slow atomic step must end this frame's work");
  assert.equal(logs.length, 0);
  clock += 2000;
  tick(scene);
  assert.equal(logs.length, 0);
  for (let i = 0; i < 10; i++) tick(scene);
  assert.equal(logs.length, 0);
  let report;
  t.mock.method(console, "log", (_message, stats) => { report = stats; });
  creationStats.flush();
  assert.equal(report["interior.complete"].count, 1);
  assert.equal(report["interior.cpu.ms"].total, 24);
  assert.equal(report["interior.slice.ms"].max, 3);
});

test("structural work preempts furniture and cheap steps use the time budget", (t) => {
  let clock = 0, furnitureSteps = 0, structureSteps = 0;
  t.mock.method(performance, "now", () => clock);
  const scene = fakeScene();
  enqueueInteriorBuild(scene, {
    label: "furniture", background: true, priority: () => 0, valid: () => true,
    steps: (function* () { while (true) { furnitureSteps++; clock += 0.1; yield "furniture"; } })(),
    complete: () => {}, cancel: () => {},
  });
  tick(scene);
  assert.ok(furnitureSteps > 8, "cheap steps should not stop at the old eight-step cap");
  const paused = furnitureSteps;
  enqueueInteriorBuild(scene, {
    label: "floor", priority: () => 10, valid: () => true,
    steps: (function* () { while (true) { structureSteps++; clock += 0.1; yield "wall"; } })(),
    complete: () => {}, cancel: () => {},
  });
  tick(scene);
  assert.equal(furnitureSteps, paused);
  assert.ok(structureSteps > 8);
  scene.onDisposeObservable.notifyObservers(scene);
});

test("exteriors get an opportunity after two frames even when nearby structures remain", async (t) => {
  const scene = fakeScene();
  let frames = 0;
  mockAnimationFrame(t, (callback) => { frames++; tick(scene); callback(); });
  enqueueInteriorBuild(scene, {
    label: "large floor", priority: () => 0, valid: () => true,
    steps: (function* () { while (true) yield "geometry"; })(),
    complete: () => {}, cancel: () => {},
  });
  await yieldToNearbyInteriors(scene);
  assert.equal(frames, 2);
  scene.onDisposeObservable.notifyObservers(scene);
});

test("cancelling active and queued jobs cleans up exactly once", (t) => {
  t.mock.method(performance, "now", () => 0);
  t.mock.method(console, "log", () => {});
  const scene = fakeScene();
  let valid = true, returned = 0, cancelled = 0, queuedStarted = false;
  enqueueInteriorBuild(scene, {
    label: "active", valid: () => valid,
    steps: (function* () { try { while (true) yield "geometry"; } finally { returned++; } })(),
    complete: () => assert.fail("Cancelled job completed"), cancel: () => cancelled++,
  });
  const cancel = enqueueInteriorBuild(scene, {
    label: "queued", valid: () => true,
    steps: (function* () { queuedStarted = true; yield "geometry"; })(),
    complete: () => assert.fail("Cancelled job completed"), cancel: () => cancelled++,
  });
  tick(scene);
  cancel(); cancel();
  valid = false;
  tick(scene); tick(scene);
  assert.equal(returned, 1);
  assert.equal(cancelled, 2);
  assert.equal(queuedStarted, false);
});

test("failed work cleans up without retrying and the next building can proceed", (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const scene = fakeScene();
  let retry, finished = false;
  enqueueInteriorBuild(scene, {
    label: "failure", valid: () => true,
    steps: (function* () { throw new Error("geometry failed"); })(),
    complete: () => assert.fail("Failed job completed"), cancel: (value) => { retry = value; },
  });
  enqueueInteriorBuild(scene, {
    label: "next", valid: () => true, steps: (function* () {})(),
    complete: () => { finished = true; }, cancel: () => assert.fail("Unexpected cancellation"),
  });
  tick(scene); tick(scene);
  assert.equal(retry, false);
  assert.equal(finished, true);
});
