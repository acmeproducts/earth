import assert from "node:assert/strict";
import test from "node:test";
import { Observable } from "@babylonjs/core";
import { enqueueInteriorBuild, INTERIOR_STEPS_PER_FRAME } from "../src/procedural/InteriorStreaming.ts";

function fakeScene() {
  return { frame: 0, getFrameId() { return this.frame; },
    onAfterRenderObservable: new Observable(), onDisposeObservable: new Observable() };
}
function tick(scene) {
  scene.frame++;
  scene.onAfterRenderObservable.notifyObservers(scene);
}

test("nearest building takes priority and moving the player pauses and resumes existing work", (t) => {
  t.mock.method(performance, "now", () => 0);
  const logs = [];
  t.mock.method(console, "log", (message) => logs.push(message));
  const scene = fakeScene();
  const distances = [10, 2], work = [0, 0], created = [0, 0];
  const complete = [];
  for (let id = 0; id < 2; id++) enqueueInteriorBuild(scene, {
    label: `priority-${id}`, priority: () => distances[id], valid: () => true,
    steps: (function* () { created[id]++; for (let i = 0; i < 30; i++) { work[id]++; yield "geometry"; } })(),
    complete: () => complete.push(id), cancel: () => assert.fail("Focus changes must not discard work"),
  });
  tick(scene);
  assert.deepEqual(work, [0, 8], "nearest beats enqueue order");
  distances[0] = 1; distances[1] = 10;
  tick(scene);
  assert.deepEqual(work, [8, 8], "switch without advancing the previous building");
  distances[0] = 10; distances[1] = 1;
  tick(scene);
  assert.deepEqual(work, [8, 16], "resume from saved progress");
  for (let frame = 0; frame < 10; frame++) tick(scene);
  assert.deepEqual(work, [30, 30]);
  assert.deepEqual(created, [1, 1]);
  assert.deepEqual(complete, [1, 0]);
  assert.equal(logs.filter((line) => line.includes(" resumed ")).length, 1, "focus logs are throttled");
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
  assert.deepEqual(work, [16, 0]);
  distances[1] = 1;
  tick(scene);
  assert.deepEqual(work, [16, 8]);
  scene.onDisposeObservable.notifyObservers(scene);
});

test("interior queue shares one budget, limits steps, and never advances twice in one frame", (t) => {
  t.mock.method(performance, "now", () => 0);
  t.mock.method(console, "log", () => {});
  const scene = fakeScene();
  const work = [0, 0], completed = [];
  for (let id = 0; id < 2; id++) enqueueInteriorBuild(scene, {
    label: `job-${id}`, valid: () => true,
    steps: (function* () { for (let i = 0; i < 20; i++) { work[id]++; yield "geometry"; } })(),
    complete: () => completed.push(id), cancel: () => assert.fail("Unexpected cancellation"),
  });
  tick(scene);
  assert.equal(work[0], INTERIOR_STEPS_PER_FRAME);
  assert.equal(work[1], 0);
  scene.onAfterRenderObservable.notifyObservers(scene);
  assert.equal(work[0], INTERIOR_STEPS_PER_FRAME);
  for (let i = 0; i < 10; i++) tick(scene);
  assert.deepEqual(work, [20, 20]);
  assert.deepEqual(completed, [0, 1]);
});

test("time budget stops a slice, progress logs are throttled, and completion reports timings", (t) => {
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
  assert.equal(logs.length, 1);
  clock += 2000;
  tick(scene);
  assert.equal(logs.filter((line) => line.includes(" progress ")).length, 1);
  for (let i = 0; i < 10; i++) tick(scene);
  assert.equal(logs.length, 3, "only start, throttled progress and completion");
  assert.match(logs.at(-1), /complete.*cpu=24\.0ms.*maxSlice=3\.00ms.*geometry:24\.0ms/);
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
