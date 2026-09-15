import assert from "node:assert/strict";
import test from "node:test";
import {
  StreamingTrace,
  streamingDiagnosticsSnapshot,
  traceStreamingSynchronous,
} from "../src/diagnostics/StreamingDiagnostics.ts";

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
