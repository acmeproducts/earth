import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { WorkerTaskClient } from "../src/core/workers/WorkerTaskClient.ts";
import { exposeWorkerTask } from "../src/core/workers/WorkerTask.ts";
import { runRoadPlanningTask } from "../src/roads/RoadPlanningTask.ts";
import { planRoadsAndBuildings } from "../src/roads/RoadAndBuildingPlanner.ts";
import { recordWorkerStages, streamingDiagnosticsSnapshot } from "../src/diagnostics/StreamingDiagnostics.ts";
import { creationStats } from "../src/diagnostics/CreationStats.ts";

function planningInput() {
  const appearance = { roadClass: "minor", widthMeters: 2, shoulderWidthMeters: 1,
    surface: "paved", visualStyle: "paved", structure: "surface", layer: 0, isTunnel: false };
  return {
    roads: [
      { id: "east-west", paths: [[{ x: -20, z: 0 }, { x: 20, z: 0 }]], appearance },
      { id: "north-south", paths: [[{ x: 0, z: -20 }, { x: 0, z: 20 }]], appearance },
    ],
    buildings: [{ id: "house", outline: [
      { x: 5, z: 5 }, { x: 9, z: 5 }, { x: 9, z: 9 }, { x: 5, z: 9 },
    ] }],
    lamps: [{ id: "mapped", position: { x: 4, z: 0 } }],
    options: { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 },
  };
}

function harness(maxPending = 32, timeout = 60_000) {
  const workers = [];
  const client = new WorkerTaskClient(() => {
    const worker = { messages: [], terminated: false,
      postMessage(message) { this.messages.push(structuredClone(message)); },
      terminate() { this.terminated = true; },
      reply(response) { this.onmessage?.({ data: response }); },
    };
    workers.push(worker);
    return worker;
  }, maxPending, timeout);
  return { client, workers };
}

test("worker client is lazy, serializes queued tasks, and correlates replies", async (t) => {
  const { client, workers } = harness();
  t.after(() => client.dispose());
  assert.equal(workers.length, 0);
  const first = client.run({ value: 1 });
  const second = client.run({ value: 2 });
  const worker = workers[0];
  assert.equal(worker.messages.length, 1);
  worker.reply({ id: 999, ok: true, output: "stale" });
  assert.equal(worker.messages.length, 1);
  worker.reply({ id: 1, ok: true, output: "first" });
  assert.equal(await first, "first");
  assert.equal(worker.messages.length, 2);
  worker.reply({ id: 2, ok: false, error: { name: "RangeError", message: "bad input" } });
  await assert.rejects(second, { name: "RangeError", message: "bad input" });
  const third = client.run({ value: 3 });
  worker.reply({ id: 3, ok: true, output: "third" });
  assert.equal(await third, "third");
  assert.equal(workers.length, 1);
});

test("reset cancels active and queued work, ignores old workers, and permits reuse", async () => {
  const { client, workers } = harness();
  const first = assert.rejects(client.run(1), { name: "AbortError" });
  const second = assert.rejects(client.run(2), { name: "AbortError" });
  const staleReply = workers[0].onmessage;
  client.reset();
  await Promise.all([first, second]);
  assert.equal(workers[0].terminated, true);
  const third = client.run(3);
  staleReply({ data: { id: 3, ok: true, output: "wrong" } });
  workers[1].reply({ id: 3, ok: true, output: "new" });
  assert.equal(await third, "new");
  client.dispose();
  assert.equal(workers[1].terminated, true);
  await assert.rejects(client.run(4), /disposed/);
});

test("queue capacity, startup failures, serialization failures, crashes, and timeout reject", async () => {
  const { client, workers } = harness(1, 10);
  const timeout = assert.rejects(client.run(1), /timed out/);
  await assert.rejects(client.run(2), /queue is full/);
  await timeout;
  assert.equal(workers[0].terminated, true);
  const crash = assert.rejects(client.run(3), /crashed/);
  workers[1].onerror({ message: "crashed", preventDefault() {} });
  await crash;
  const deserialize = assert.rejects(client.run(4), /deserialized/);
  workers[2].onmessageerror();
  await deserialize;
  client.dispose();
  const startup = new WorkerTaskClient(() => { throw new Error("startup"); });
  await assert.rejects(startup.run(1), /startup/);
  startup.dispose();
  const clone = harness();
  await assert.rejects(clone.client.run(() => {}), { name: "DataCloneError" });
  assert.equal(clone.workers[0].terminated, true);
  clone.client.dispose();
});

test("worker endpoint returns results and serializes task errors", async () => {
  const replies = [];
  const scope = { postMessage: (reply) => replies.push(structuredClone(reply)) };
  exposeWorkerTask(scope, (value) => {
    if (value < 0) throw new RangeError("negative");
    return value * 2;
  });
  await scope.onmessage({ data: { id: 1, input: 4 } });
  await scope.onmessage({ data: { id: 2, input: -1 } });
  assert.deepEqual(replies[0], { id: 1, ok: true, output: 8 });
  assert.equal(replies[1].error.name, "RangeError");
  assert.equal(replies[1].error.message, "negative");
});

test("worker planning is cloneable, unchanged, and returns all phase timings", () => {
  const input = planningInput();
  const original = structuredClone(input);
  const result = structuredClone(runRoadPlanningTask(structuredClone(input)));
  assert.deepEqual(result.plan, planRoadsAndBuildings(input.roads, input.buildings, input.options, input.lamps));
  assert.deepEqual(input, original);
  assert.equal(result.timings.length, 12);
  assert.ok(result.timings.every((entry) => entry.durationMilliseconds >= 0));
});

test("real worker entry plans crossing roads without changing the synchronous result", { timeout: 10_000 }, async (t) => {
  const worker = new Worker(new URL("./fixtures/road-planning-worker.mjs", import.meta.url));
  t.after(() => worker.terminate());
  const input = planningInput();
  const response = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.postMessage({ id: 42, input });
  });
  assert.equal(response.id, 42);
  assert.equal(response.ok, true);
  assert.deepEqual(response.output.plan, planRoadsAndBuildings(input.roads, input.buildings, input.options, input.lamps));
  assert.equal(response.output.timings.length, 12);
});

test("worker timings are page-aligned and clearly separated from main-thread slow work", () => {
  recordWorkerStages("worker timing test", [{ stage: "test phase", startTimeMilliseconds: 10,
    durationMilliseconds: 100 }], performance.timeOrigin + 500);
  const entry = streamingDiagnosticsSnapshot().stages.at(-1);
  assert.equal(entry.startTimeMilliseconds, 510);
  assert.equal(entry.executionThread, "worker");
  assert.equal(entry.timingKind, "synchronous");
  assert.equal(creationStats.slowOperationsSnapshot().operations.some((s) => s.category === "worker.stage.test phase"), true);
  assert.equal(creationStats.slowOperationsSnapshot().operations.some((s) => s.category === "streaming.stage.test phase"), false);
});
