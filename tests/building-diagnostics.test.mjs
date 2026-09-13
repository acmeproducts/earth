import assert from "node:assert/strict";
import test from "node:test";
import { BuildingTrace } from "../src/BuildingDiagnostics.ts";

test("building diagnostics preserve sync/async results, failures, and disable behavior", async () => {
  const messages = [];
  const originalLog = console.log;
  const previous = globalThis.buildingTimingEnabled;
  console.log = (message) => messages.push(message);
  globalThis.buildingTimingEnabled = true;
  try {
    const value = {};
    assert.equal(BuildingTrace.run("sync", (trace) => { trace.stage("geometry"); return value; }), value);
    assert.match(messages.at(-1), /sync status=ok.*geometry=\d+\.\d{2}ms/);
    const failure = new Error("planner failed");
    assert.throws(() => BuildingTrace.run("failure", () => { throw failure; }), (error) => error === failure);
    assert.match(messages.at(-1), /failure status=error/);
    assert.equal(await BuildingTrace.runAsync("async", async (trace) => {
      trace.stage("yield");
      await Promise.resolve();
      trace.stage("activation");
      return value;
    }), value);
    assert.match(messages.at(-1), /async status=ok.*yield=.*activation=/);
    await assert.rejects(BuildingTrace.runAsync("async failure", async () => { throw failure; }),
      (error) => error === failure);
    assert.match(messages.at(-1), /async failure status=error/);
    globalThis.buildingTimingEnabled = false;
    const count = messages.length;
    assert.equal(BuildingTrace.run("disabled", (trace) => { trace.stage("work"); return value; }), value);
    assert.equal(messages.length, count);
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete globalThis.buildingTimingEnabled;
    else globalThis.buildingTimingEnabled = previous;
  }
});
