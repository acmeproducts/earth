import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { Mesh, NullEngine, Scene } from "@babylonjs/core";
import { WorkerTaskClient } from "../src/core/workers/WorkerTaskClient.ts";
import { runBuildingPlanning } from "../src/buildings/BuildingPlanningTask.ts";
import { planBuilding } from "../src/buildings/BuildingPlanner.ts";
import { ProceduralBuildingRenderer } from "../src/procedural/ProceduralBuildingRenderer.ts";

function planner(t) {
  const client = new WorkerTaskClient(() => {
    const worker = new Worker(new URL("./fixtures/building-planning-worker.mjs", import.meta.url));
    const adapter = { postMessage: (data) => worker.postMessage(data), terminate: () => worker.terminate() };
    worker.on("message", (data) => adapter.onmessage?.({ data }));
    worker.on("error", (error) => adapter.onerror?.({ message: error.message, preventDefault() {} }));
    return adapter;
  });
  t.after(() => client.dispose());
  return { plan: async (input) => (await client.run(input)).result, reset: () => client.reset() };
}

const terrain = { elevations: new Float32Array([10, 10, 10, 10]), minElevation: 10, maxElevation: 10,
  width: 2, height: 2, bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 } };
const rectangle = (a, b) => [[a,a],[b,a],[b,b],[a,b],[a,a]];
const options = { meshWidth: 50, meshDepth: 50, metersPerUnit: 1, renderWholeBuildingFootprints: true };
const building = (complex) => planBuilding({ id: "worker-test",
  polygon: { outer: rectangle(0.1, 0.9), holes: complex ? [rectangle(0.35, 0.65)] : [] },
  properties: { building: "apartments", render_height: 9.3 } });
const snapshot = (mesh) => ({
  indices: Array.from(mesh.getIndices()),
  buffers: Object.fromEntries(mesh.getVerticesDataKinds().map((kind) => [kind, Array.from(mesh.getVerticesData(kind))])),
  metadata: Object.fromEntries(Object.entries(mesh.metadata).filter(([key]) => key !== "pendingInterior")),
});

test("worker structured cloning preserves floor layouts, apartments and invalid-footprint fallbacks", async (t) => {
  const worker = planner(t);
  const input = { kind: "building", input: { buildingType: "house",
    buildingPolygon: { outer: [{x:0,y:0},{x:40,y:0},{x:40,y:30},{x:0,y:30}] } } };
  const actual = await worker.plan(input);
  assert.deepEqual(actual, runBuildingPlanning(input));
  assert.ok(actual.interior);
  for (const use of ["residential", "hotel", "office"]) {
    const apartments = { kind: "apartments", building: actual.interior.building, facadeOpenings: [], seed: 42, use };
    assert.deepEqual(await worker.plan(apartments), runBuildingPlanning(apartments));
  }
  const invalid = { kind: "building", input: { buildingType: "house", buildingPolygon: { outer: [] } } };
  assert.deepEqual(await worker.plan(invalid), runBuildingPlanning(invalid));
});

for (const complex of [false, true]) test(`async ${complex ? "courtyard" : "ordinary"} renderer preserves geometry and metadata`, async (t) => {
  const worker = planner(t);
  const engine = new NullEngine(), scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const plan = building(complex);
  const expected = ProceduralBuildingRenderer.createDetailed(scene, plan, terrain, options);
  let yields = 0, tasks = 0;
  const actual = await ProceduralBuildingRenderer.createDetailedAsync(scene, plan, terrain, options,
    { plan: (input) => { tasks++; return worker.plan(input); } }, async () => { yields++; });
  assert.ok(tasks >= 2);
  assert.ok(yields > tasks + 4, "geometry must also have yield boundaries");
  assert.deepEqual(snapshot(actual), snapshot(expected));
});

test("cancelled compilation disposes its staged meshes but not concurrent scene additions", async (t) => {
  const engine = new NullEngine(), scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  let cancelled = false, unrelated;
  await assert.rejects(ProceduralBuildingRenderer.createDetailedAsync(scene, building(true), terrain, options,
    { plan: async (input) => {
      assert.ok(scene.meshes.length > 0, "complex facades should already be staged");
      unrelated = new Mesh("concurrent tile", scene);
      cancelled = true;
      return runBuildingPlanning(input);
    } }, async () => {}, () => cancelled), { name: "AbortError" });
  assert.deepEqual(scene.meshes.map((mesh) => mesh.name), ["concurrent tile"]);
  assert.equal(unrelated.isDisposed(), false);
});

test("worker failure cleans up partial complex geometry without synchronous fallback", async (t) => {
  const engine = new NullEngine(), scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  await assert.rejects(ProceduralBuildingRenderer.createDetailedAsync(scene, building(true), terrain, options,
    { plan: async () => { throw new Error("worker failed"); } }, async () => {}), /worker failed/);
  assert.equal(scene.meshes.length, 0);
});

test("reset rejects in-flight planning and a fresh worker can accept the next task", async (t) => {
  const worker = planner(t);
  const input = { kind: "building", input: { buildingType: "house",
    buildingPolygon: { outer: [{x:0,y:0},{x:20,y:0},{x:20,y:20},{x:0,y:20}] } } };
  const pending = worker.plan(input);
  worker.reset();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(await worker.plan(input), runBuildingPlanning(input));
});
