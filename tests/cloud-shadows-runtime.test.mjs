import assert from "node:assert/strict";
import test from "node:test";
import { NullEngine, Scene, Vector3 } from "@babylonjs/core";

const { createCloudShadowProjector } = await import("../src/CloudShadows.ts");
const { cloudPlacementsAround } = await import("../src/CloudDistribution.ts");
const { createTerrainMaterial } = await import("../src/TerrainMaterial.ts");

test("nearest cloud footprints bind directly to the terrain receiver", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const projector = createCloudShadowProjector(scene, 50);
  const terrainMaterial = createTerrainMaterial(scene, { usesLandCoverTint: true });
  const placements = cloudPlacementsAround(0, 0, 18_000, 50, 42);

  projector.upload(placements);
  projector.setDrift(2, -1);
  projector.update(Vector3.Zero(), new Vector3(0.3, 0.8, 0.2).normalize());

  assert.equal(terrainMaterial.constructor.name, "CustomMaterial");
  const nearest = terrainMaterial._newUniformInstances["vec4-cloudShadowPlacement0"];
  assert.ok(nearest.z > 0);
  assert.ok(nearest.w > 0);
  assert.equal(scene.customRenderTargets.length, 0);

  projector.dispose();
  assert.equal(nearest.z, 0);
  assert.equal(nearest.w, 0);
  scene.dispose();
  engine.dispose();
});
