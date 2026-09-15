import assert from "node:assert/strict";
import test from "node:test";
import { Matrix, NullEngine, Ray, Scene, Vector3 } from "@babylonjs/core";
import { planBuilding } from "../src/BuildingPlanner.ts";
import { lonLatToScene, sampleElevation } from "../src/Geo.ts";
import { conformTerrainToPlannedFeatures } from "../src/PlannedFeatureTerrain.ts";
import { planRoadsAndBuildings } from "../src/RoadAndBuildingPlanner.ts";
import { ProceduralBuildingRenderer } from "../src/procedural/ProceduralBuildingRenderer.ts";

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
