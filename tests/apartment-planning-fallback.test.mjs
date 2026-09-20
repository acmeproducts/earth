import assert from "node:assert/strict";
import test from "node:test";
import { runBuildingPlanning } from "../src/buildings/BuildingPlanningTask.ts";
import { planInteriorFurniture } from "../src/procedural/InteriorFurniture.ts";

test("failed small-apartment subdivision preserves the suite and its furnishings", () => {
  const polygon = { outer: [{x:0,y:0},{x:3,y:0},{x:3,y:3},{x:0,y:3}] };
  const opening = { id: "entrance", type: "door", start: {x:0,y:0.4}, end: {x:0,y:1.4} };
  const result = runBuildingPlanning({ kind: "apartments", use: "residential", seed: 42,
    facadeOpenings: [], building: { buildingType: "house", boundary: polygon,
      rooms: [{ id: "small-suite", type: "apartment", polygon }], openings: [opening] } });
  assert.match(result.failure, /at least 10/);
  assert.equal(result.apartments.length, 1);
  assert.equal(result.apartments[0].boundary, polygon);
  assert.deepEqual(result.apartments[0].openings, [opening]);
  assert.ok(planInteriorFurniture(result.apartments[0], 42).length > 0);
});
