import assert from "node:assert/strict";
import test from "node:test";
import { creationStats, SLOW_OPERATION_THRESHOLD_MS } from "../src/diagnostics/CreationStats.ts";
import {
  StreamingTrace,
  streamingDiagnosticsSnapshot,
  traceStreamingSynchronous,
} from "../src/diagnostics/StreamingDiagnostics.ts";

test("general slow-operation stats reject invalid timings and fast samples", (t) => {
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args));
  creationStats.flush();
  for (const value of [0, -1, 32, NaN, Infinity]) creationStats.recordSlowOperation("test.callback", value);
  creationStats.recordSlowOperation("test.callback", 40);
  creationStats.recordSlowOperation("test.callback", 60);
  creationStats.flush();
  assert.deepEqual(logs.at(-1)[1]["slow.test.callback.ms"], {
    count: 2, total: 100, average: 50, min: 40, max: 60,
  });
});

test("performance-view slow summaries survive console flushing and stay bounded", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.method(console, "log", () => {});
  const capacity = creationStats.slowOperationsSnapshot().capacity;
  for (let index = 0; index < capacity; index++) {
    now++;
    creationStats.recordSlowOperation("view.old", 40);
  }
  now = 1000;
  creationStats.recordSlowOperation("view.planner", 100);
  now = 2000;
  creationStats.recordSlowOperation("view.planner", 50);
  creationStats.flush();
  const snapshot = creationStats.slowOperationsSnapshot();
  assert.equal(snapshot.sampleCount, capacity);
  assert.deepEqual(snapshot.operations[0], {
    category: "view.planner", count: 2, maximumMilliseconds: 100,
    latestMilliseconds: 50, recordedAtMilliseconds: 2000,
  });
  assert.equal(snapshot.operations[1].count, capacity - 2);
  snapshot.operations[0].count = 0;
  assert.equal(creationStats.slowOperationsSnapshot().operations[0].count, 2);
});

test("slow synchronous work is retained and logged without enabling detailed stats", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args));
  creationStats.flush();
  const trace = new StreamingTrace("slow test");
  now += 100;
  trace.stage("threshold", "synchronous");
  now += SLOW_OPERATION_THRESHOLD_MS;
  trace.stage("slow work", "synchronous");
  now += SLOW_OPERATION_THRESHOLD_MS + 1;
  trace.finish();
  trace.finish();
  const entries = streamingDiagnosticsSnapshot().slowOperations.filter((entry) => entry.label === "slow test");
  assert.deepEqual(entries.map((entry) => entry.stage), ["slow work"]);
  assert.equal(entries[0].durationMilliseconds, 33);
  entries[0].stage = "mutated";
  assert.equal(streamingDiagnosticsSnapshot().slowOperations.at(-1).stage, "slow work");
  creationStats.flush();
  assert.equal(logs.at(-1)[1]["slow.streaming.stage.slow work.ms"].count, 1);
  assert.equal(logs.at(-1)[1]["slow.streaming.stage.threshold.ms"], undefined);
});

test("slow history is bounded and survives ordinary stage history rollover", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const { slowOperationCapacity, capacity } = streamingDiagnosticsSnapshot();
  for (let index = 0; index < slowOperationCapacity + 5; index++) {
    traceStreamingSynchronous(`slow bounded ${index}`, () => { now += 40; });
  }
  for (let index = 0; index < capacity + 1; index++) {
    traceStreamingSynchronous("fast", () => {});
  }
  const entries = streamingDiagnosticsSnapshot().slowOperations;
  assert.equal(entries.length, slowOperationCapacity);
  assert.equal(entries[0].label, "slow bounded 5");
  assert.equal(entries.at(-1).label, `slow bounded ${slowOperationCapacity + 4}`);
});

test("streaming stages retain identity, timestamps and unfinished work", () => {
  const trace = new StreamingTrace("test tile");
  trace.stage("terrain mesh");
  const active = streamingDiagnosticsSnapshot().activeStages.find((entry) => entry.label === "test tile");
  assert.equal(active.stage, "terrain mesh");
  assert.equal(active.completed, false);
  assert.equal(active.timingKind, "wall-clock");
  trace.finish();
  const snapshot = streamingDiagnosticsSnapshot();
  assert.equal(snapshot.activeStages.some((entry) => entry.traceId === active.traceId), false);
  const completed = snapshot.stages.find((entry) => entry.traceId === active.traceId && entry.stage === "terrain mesh");
  assert.equal(completed.startTimeMilliseconds, active.startTimeMilliseconds);
  assert.ok(completed.durationMilliseconds >= active.durationMilliseconds);
  assert.equal(completed.completed, true);
  const count = snapshot.stages.length;
  trace.finish();
  trace.stage("ignored");
  assert.equal(streamingDiagnosticsSnapshot().stages.length, count);
  completed.label = "mutated snapshot";
  assert.ok(streamingDiagnosticsSnapshot().stages.some((entry) => entry.label === "test tile"));
});

test("synchronous operations preserve return values and failures", () => {
  assert.equal(traceStreamingSynchronous("return test", () => 42), 42);
  const failure = new Error("disposal failed");
  assert.throws(() => traceStreamingSynchronous("throw test", () => { throw failure; }), (error) => error === failure);
  const snapshot = streamingDiagnosticsSnapshot();
  assert.equal(snapshot.activeStages.length, 0);
  assert.equal(snapshot.stages.find((entry) => entry.label === "throw test").timingKind, "synchronous");
});

test("stage timing kinds describe the work before the next marker", () => {
  const trace = new StreamingTrace("mixed terrain");
  trace.stage("lake levels", "synchronous");
  assert.equal(streamingDiagnosticsSnapshot().activeStages.find((entry) =>
    entry.label === "mixed terrain").timingKind, "synchronous");
  trace.stage("raster with yields");
  trace.stage("normal computation", "synchronous");
  trace.finish();
  const stages = streamingDiagnosticsSnapshot().stages.filter((entry) =>
    entry.label === "mixed terrain");
  assert.deepEqual(stages.map(({ stage, timingKind }) => [stage, timingKind]), [
    ["starting", "wall-clock"],
    ["lake levels", "synchronous"],
    ["raster with yields", "wall-clock"],
    ["normal computation", "synchronous"],
  ]);
});

test("history is bounded and remains in completion order after wrapping", () => {
  const capacity = streamingDiagnosticsSnapshot().capacity;
  for (let index = 0; index < capacity + 5; index++) {
    traceStreamingSynchronous(`bounded ${index}`, () => {});
  }
  const snapshot = streamingDiagnosticsSnapshot();
  assert.equal(snapshot.stages.length, capacity);
  assert.equal(snapshot.stages[0].label, "bounded 5");
  assert.equal(snapshot.stages.at(-1).label, `bounded ${capacity + 4}`);
});
