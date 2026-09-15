import assert from "node:assert/strict";
import test from "node:test";
import { BuildingTrace } from "../src/buildings/BuildingDiagnostics.ts";
import { creationStats, CREATION_STATS_INTERVAL_MS } from "../src/diagnostics/CreationStats.ts";
import { StreamingTrace, streamingDiagnosticsSnapshot } from "../src/diagnostics/StreamingDiagnostics.ts";

test("building diagnostics preserve sync/async results, failures, and disable behavior", async () => {
  const messages = [];
  const originalLog = console.log;
  const previous = globalThis.buildingTimingEnabled;
  console.log = (...message) => messages.push(message);
  globalThis.buildingTimingEnabled = true;
  try {
    const value = {};
    assert.equal(BuildingTrace.run("sync", (trace) => { trace.stage("geometry"); return value; }), value);
    assert.equal(messages.length, 0);
    const failure = new Error("planner failed");
    assert.throws(() => BuildingTrace.run("failure", () => { throw failure; }), (error) => error === failure);
    assert.equal(await BuildingTrace.runAsync("async", async (trace) => {
      trace.stage("yield");
      await Promise.resolve();
      trace.stage("activation");
      return value;
    }), value);
    await assert.rejects(BuildingTrace.runAsync("async failure", async () => { throw failure; }),
      (error) => error === failure);
    assert.equal(messages.length, 0);
    creationStats.flush();
    const stats = messages.at(-1)[1];
    assert.equal(stats["building.completed.ms"].count, 2);
    assert.equal(stats["building.failed.ms"].count, 2);
    assert.equal(stats["building.stage.geometry.ms"].count, 1);
    assert.equal(stats["building.stage.activation.ms"].count, 1);
    globalThis.buildingTimingEnabled = false;
    const count = messages.length;
    assert.equal(BuildingTrace.run("disabled", (trace) => { trace.stage("work"); return value; }), value);
    globalThis.buildingTimingEnabled = true;
    BuildingTrace.run("silent", (trace) => trace.stage("work"), false);
    creationStats.flush();
    assert.equal(messages.length, count);
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete globalThis.buildingTimingEnabled;
    else globalThis.buildingTimingEnabled = previous;
  }
});

test("creation stats batch bursts, reset intervals, and stay silent when idle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const messages = [];
  t.mock.method(console, "log", (...args) => messages.push(args));
  for (let i = 0; i < 1000; i++) creationStats.record("test.ms", i);
  t.mock.timers.tick(CREATION_STATS_INTERVAL_MS - 1);
  assert.equal(messages.length, 0);
  t.mock.timers.tick(1);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0][1]["test.ms"], {
    count: 1000, total: 499500, average: 499.5, min: 0, max: 999,
  });
  t.mock.timers.tick(CREATION_STATS_INTERVAL_MS * 2);
  assert.equal(messages.length, 1);
  creationStats.record("test.ms", 5);
  t.mock.timers.tick(CREATION_STATS_INTERVAL_MS);
  assert.equal(messages.length, 2);
  assert.equal(messages[1][1]["test.ms"].count, 1);
});

test("streaming aggregates across tiles and records completion only once", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const messages = [];
  t.mock.method(console, "log", (...args) => messages.push(args));
  for (let i = 0; i < 100; i++) {
    const trace = new StreamingTrace(`tile=${i}`);
    trace.stage("terrain");
    now += 5;
    trace.finish();
    trace.finish();
  }
  assert.equal(messages.length, 0);
  creationStats.flush();
  assert.equal(messages.length, 1);
  assert.equal(messages[0][1]["streaming.finished.ms"].count, 100);
  assert.equal(messages[0][1]["streaming.stage.terrain.ms"].total, 500);
});

test("synchronous building stages retain building identity and finish after errors", () => {
  const error = new Error("geometry failure");
  assert.throws(() => BuildingTrace.run("building=test-identity", (trace) => {
    trace.stage("stair layout");
    throw error;
  }), (caught) => caught === error);
  const snapshot = streamingDiagnosticsSnapshot();
  const stage = snapshot.stages.find((entry) => entry.label === "building=test-identity" &&
    entry.stage === "building stair layout");
  assert.ok(stage);
  assert.equal(stage.timingKind, "synchronous");
  assert.equal(stage.executionThread, "main");
  assert.equal(stage.completed, true);
  assert.ok(!snapshot.activeStages.some((entry) => entry.label === "building=test-identity"));
});

test("async building traces do not report scheduled waits as synchronous work", async () => {
  await BuildingTrace.runAsync("building=async-wait", async (trace) => {
    trace.stage("frame yield");
    await Promise.resolve();
  });
  BuildingTrace.run("building=unlogged", () => {}, false);
  const snapshot = streamingDiagnosticsSnapshot();
  assert.ok(!snapshot.stages.some((entry) =>
    entry.label === "building=async-wait" || entry.label === "building=unlogged"));
  assert.ok(!snapshot.activeStages.some((entry) => entry.label === "building=unlogged"));
});
