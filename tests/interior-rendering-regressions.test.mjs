import assert from "node:assert/strict";
import test from "node:test";
import { Mesh, NullEngine, Ray, Scene, Vector3 } from "@babylonjs/core";
import { planBuilding } from "../src/buildings/BuildingPlanner.ts";
import { ProceduralBuildingRenderer } from "../src/procedural/ProceduralBuildingRenderer.ts";

const terrain = { elevations: new Float32Array([10,10,10,10]), minElevation: 10, maxElevation: 10,
  width: 2, height: 2, bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 } };
const options = { meshWidth: 100, meshDepth: 100, metersPerUnit: 1, renderWholeBuildingFootprints: true };
const plan = planBuilding({ id: "interior-regression", properties: { building: "house", render_height: 3.1 },
  polygon: { outer: [[0.4,0.4],[0.6,0.4],[0.6,0.6],[0.4,0.6],[0.4,0.4]], holes: [] } });
const rectangle = (left, right) => ({ outer: [{x:left,y:-10},{x:right,y:-10},{x:right,y:10},{x:left,y:10}] });
const door = (id, from, to) => ({ id, type: "door", start: {x:0,y:from}, end: {x:0,y:to} });

test("rendered clipped partition stays solid and overlapping door records create one leaf", async (t) => {
  const engine = new NullEngine(), scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const boundary = rectangle(-10, 10);
  const planner = { plan: async (request) => request.kind === "building" ? {
    input: request.input, interior: { apartments: [], building: {
      buildingType: "house", boundary, rooms: [{id:"suite",type:"apartment",polygon:boundary}],
      openings: request.input.openings,
    } },
  } : { apartments: [{ boundary, rooms: [
    {id:"left",type:"room",polygon:rectangle(-10,0)}, {id:"right",type:"room",polygon:rectangle(0,10)},
  ], openings: [door("partial",-10.5,-9.2),door("first",0,1),door("overlapping",0.5,1.5)] }] } };
  const shell = await ProceduralBuildingRenderer.createDetailedAsync(scene, plan, terrain, options, planner, async () => {});
  const root = new Mesh("interior",scene);
  for (const _ of shell.metadata.pendingInterior.floors[0].build(root)) { /* Drain geometry. */ }
  const doors = root.getChildMeshes().filter(mesh => mesh.metadata?.buildingDoor);
  assert.equal(doors.filter(mesh => ["first","overlapping"].includes(mesh.metadata.openingId)).length, 1);
  const structure = root.getChildMeshes().filter(mesh => !mesh.metadata?.buildingDoor && mesh.name !== "doorHandle");
  const hits = (z) => structure.some(mesh => mesh.intersects(Ray.Transform(
    new Ray(new Vector3(-1,11,z),Vector3.Right(),2),mesh.computeWorldMatrix(true).clone().invert())).hit);
  assert.ok(hits(5), "partial doorway overlap must not erase the remaining ten-meter wall");
  assert.equal(hits(0.75),false,"the merged doorway stays open in the partition");
});

test("residential planning failure still generates furniture within a floor", async (t) => {
  const engine = new NullEngine(), scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const shell = await ProceduralBuildingRenderer.createDetailedAsync(scene, plan, terrain, options,
    { plan: async request => ({ input: request.input, failure: "invalid subdivision" }) }, async () => {});
  assert.equal(shell.metadata.plannedInterior,false);
  const root = new Mesh("furniture",scene);
  for (const _ of shell.metadata.pendingInterior.floors[0].furnish(root)) { /* Drain geometry. */ }
  assert.ok(root.getChildMeshes().some(mesh => mesh.getTotalVertices() > 0), "fallback must not be an empty shell");
});
