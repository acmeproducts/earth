import assert from "node:assert/strict";
import test from "node:test";
import { NullEngine, Scene } from "@babylonjs/core";
import { planBuilding } from "../src/buildings/BuildingPlanner.ts";
import { mergeOverlappingBuildings } from "../src/buildings/CompositeBuildings.ts";
import { buildingLayoutCache } from "../src/buildings/BuildingLayoutPlanner.ts";
import { runBuildingPlanning } from "../src/buildings/BuildingPlanningTask.ts";
import { ProceduralBuildingRenderer } from "../src/procedural/ProceduralBuildingRenderer.ts";

const rectangle = (x, y, w, h) => ({ outer: [[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]], holes: [] });
const source = (id, polygon, height) => ({ id, polygon,
  properties: { building: "apartments", render_height: height } });
const courtyard = { ...rectangle(0.1, 0.1, 0.8, 0.8), holes: [rectangle(0.4, 0.4, 0.2, 0.2).outer] };
const terrain = { elevations: new Float32Array([10,10,10,10]), minElevation: 10, maxElevation: 10,
  width: 2, height: 2, bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 } };

for (const scale of [1, 10]) for (const towers of [false, true]) {
  test(`matching floors share stair reservations and cached layouts (scale=${scale}, towers=${towers})`, async () => {
    const sources = towers ? [source("podium", rectangle(0.1,0.1,0.8,0.8), 9.3),
      source("left", rectangle(0.15,0.3,0.25,0.4), 21.7), source("right", rectangle(0.6,0.3,0.25,0.4), 21.7)]
      : [source("courtyard", courtyard, 18.6)];
    const plan = planBuilding(mergeOverlappingBuildings(sources)[0]);
    const engine = new NullEngine(), scene = new Scene(engine);
    buildingLayoutCache.clear();
    const floors = [];
    let repeated = 0;
    const seen = new Map();
    try {
      const mesh = await ProceduralBuildingRenderer.createDetailedAsync(scene, plan, terrain,
        { meshWidth: 50 / scale, meshDepth: 50 / scale, metersPerUnit: scale, renderWholeBuildingFootprints: true },
        { plan: async (input) => {
          const hits = buildingLayoutCache.hits;
          const result = runBuildingPlanning(input);
          if (input.kind === "building") {
            assert.ok(result.interior, result.failure);
            floors.push(structuredClone(input.input));
            const key = JSON.stringify(input);
            if (seen.has(key)) {
              assert.ok(buildingLayoutCache.hits > hits, "identical floors must hit the layout cache");
              assert.deepEqual(result, seen.get(key));
              repeated++;
            }
            seen.set(key, structuredClone(result));
          }
          return result;
        } }, async () => {});
      assert.ok(mesh.metadata.stairFlightCount >= mesh.metadata.interiorFloorCount - 1);
      const groups = Map.groupBy(floors, (floor) => JSON.stringify(floor.buildingPolygon));
      assert.ok(groups.size >= (towers ? 3 : 1));
      for (const group of groups.values()) {
        assert.ok(group[0].circulation.length > 0);
        for (const floor of group) assert.deepEqual(floor.circulation, group[0].circulation);
        assert.equal(new Set(group[0].circulation.map((ring) => JSON.stringify(ring))).size,
          group[0].circulation.length, "incoming/outgoing copies must not duplicate reservations");
      }
      assert.ok(repeated > 0, "upper floors should reuse a complete floor plan");
    } finally { scene.dispose(); engine.dispose(); }
  });
}
