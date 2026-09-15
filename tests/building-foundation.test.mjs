import assert from "node:assert/strict";
import test from "node:test";
import { Matrix, NullEngine, Ray, Scene, Vector3 } from "@babylonjs/core";
import { planBuilding } from "../src/buildings/BuildingPlanner.ts";
import { lonLatToScene, sampleElevation } from "../src/world/Geo.ts";
import { conformTerrainToPlannedFeatures } from "../src/terrain/PlannedFeatureTerrain.ts";
import { planRoadsAndBuildings } from "../src/roads/RoadAndBuildingPlanner.ts";
import { ProceduralBuildingRenderer } from "../src/procedural/ProceduralBuildingRenderer.ts";
import { buildingGroundElevation } from "../src/terrain/BuildingGroundElevation.ts";

for (const scale of [1, 5]) for (const peak of [[40, 42], [43, 47], [50, 41]]) {
  test(`whole footprint clears terrain peak ${peak} at scale ${scale}`, () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const footprint = { outer: [[0.35, 0.42], [0.65, 0.42], [0.65, 0.58],
        [0.35, 0.58], [0.35, 0.42]], holes: [] };
      const plan = planBuilding({ id: "peak", polygon: footprint,
        properties: { building: "apartments", render_height: 8 } });
      const terrain = { elevations: new Float32Array(101 * 101).fill(10),
        minElevation: 10, maxElevation: 25, width: 101, height: 101,
        bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 } };
      const options = { meshWidth: 100 / scale, meshDepth: 100 / scale,
        metersPerUnit: scale, sharedBuildingElevations: new Map([[plan.id, 10]]) };
      terrain.elevations[peak[1] * terrain.width + peak[0]] = 25;
      for (const create of ["createDetailed", "createFar"]) {
        const mesh = ProceduralBuildingRenderer[create](scene, plan, terrain, options);
        assert.ok(mesh);
        mesh.computeWorldMatrix(true);
        const roof = mesh.getBoundingInfo().boundingBox.maximumWorld.y;
        const reference = ProceduralBuildingRenderer[create](scene, plan, terrain,
          { ...options, sharedBuildingElevations: new Map([[plan.id, 25]]) });
        reference.computeWorldMatrix(true);
        assert.ok(Math.abs(roof - reference.getBoundingInfo().boundingBox.maximumWorld.y) < 1e-5,
          `${create} must lift the building above peaks missed by corner/center sampling`);
        mesh.dispose(false, true);
        reference.dispose(false, true);
      }
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
}

test("footprint elevation excludes distant terrain and open courtyard interiors", () => {
  const terrain = { width: 101, height: 101, elevations: new Float32Array(101 * 101).fill(10) };
  const ring = (size) => [{ x: -size, z: -size }, { x: size, z: -size },
    { x: size, z: size }, { x: -size, z: size }];
  terrain.elevations[50 * 101 + 50] = 100;
  terrain.elevations[0] = 200;
  assert.equal(buildingGroundElevation(terrain, ring(20), [ring(10)], 100, 100), 10);
  assert.equal(buildingGroundElevation(terrain, ring(20), [], 100, 100), 100);
});

for (const scale of [1, 5]) for (const kind of ["ordinary", "courtyard", "composite", "raised"]) {
  test(`${kind} foundations meet road-lowered ground at scale ${scale}`, async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const footprint = {
        outer: [[0.35, 0.42], [0.65, 0.42], [0.65, 0.58], [0.35, 0.58], [0.35, 0.42]],
        holes: kind === "courtyard"
          ? [[[0.45, 0.47], [0.55, 0.47], [0.55, 0.53], [0.45, 0.53], [0.45, 0.47]]]
          : [],
      };
      const plan = planBuilding({ id: kind, polygon: footprint,
        properties: { building: "apartments", render_height: 8,
          render_min_height: kind === "raised" ? 3 : 0 } });
      if (kind === "composite") plan.heightBands = [{ minimumHeightMeters: 0,
        heightMeters: 8, footprints: [footprint], roofs: [footprint], soffits: [footprint] }];
      const terrain = {
        elevations: new Float32Array(101 * 101).fill(10),
        minElevation: 10, maxElevation: 10, width: 101, height: 101,
        bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 },
      };
      const options = { meshWidth: 100 / scale, meshDepth: 100 / scale,
        metersPerUnit: scale, sharedBuildingElevations: new Map([[plan.id, 20]]) };
      const point = (x, z) => ({ x: x / scale, z: z / scale });
      const outline = footprint.outer.slice(0, -1).map(([lon, lat]) =>
        lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth));
      const planning = planRoadsAndBuildings([{ id: "street",
        paths: [[point(-40, -10), point(40, -10)]], appearance: {
          roadClass: "minor", widthMeters: 2, shoulderWidthMeters: 1,
          surface: "paved", visualStyle: "paved", structure: "surface", layer: 0, isTunnel: false,
        } }], [{ id: plan.id, outline }], options);
      await conformTerrainToPlannedFeatures(terrain, planning, options);
      assert.ok(sampleElevation(terrain, 0, -8 / scale,
        options.meshWidth, options.meshDepth) < 15, "road must expose the gap beneath the floor");
      for (const create of ["createDetailed", "createFar"]) {
        const mesh = ProceduralBuildingRenderer[create](scene, plan, terrain, options);
        assert.ok(mesh);
        const inverseWorld = Matrix.Invert(mesh.computeWorldMatrix(true));
        const hit = mesh.intersects(Ray.Transform(new Ray(new Vector3(0, 15 / scale, -9 / scale),
          new Vector3(0, 0, 1), 2 / scale), inverseWorld));
        assert.equal(hit.hit, kind !== "raised", `${create} must support only ground-level footprints`);
        if (kind === "courtyard") {
          const courtyard = mesh.intersects(Ray.Transform(new Ray(new Vector3(0, 19 / scale, 0),
            new Vector3(0, -1, 0), 12 / scale), inverseWorld));
          assert.equal(courtyard.hit, false, "foundation must leave the courtyard open");
        }
        mesh.dispose(false, true);
      }
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
}
