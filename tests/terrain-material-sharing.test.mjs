import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { Mesh, NullEngine, Scene } from "@babylonjs/core";

register("./ts-extension-resolver.mjs", import.meta.url);
const { createTerrainMaterial, disposeTerrainMesh, isSharedTerrainMaterial } = await import(
  "../src/TerrainMaterial.ts"
);

test("terrain tiles reuse scene-owned materials and GPU textures", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);

  const tinted = Array.from(
    { length: 169 },
    () => createTerrainMaterial(scene, { usesLandCoverTint: true }),
  );
  const untinted = Array.from(
    { length: 169 },
    () => createTerrainMaterial(scene, { usesLandCoverTint: false }),
  );

  assert.ok(tinted.every((material) => material === tinted[0]));
  assert.ok(untinted.every((material) => material === untinted[0]));
  assert.notEqual(tinted[0], untinted[0]);
  assert.ok(isSharedTerrainMaterial(tinted[0]));
  assert.equal(scene.materials.length, 2);
  assert.equal(scene.textures.length, 3);

  scene.dispose();
  engine.dispose();
});

test("disposing a stale terrain mesh preserves scene-owned terrain resources", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const staleTerrain = new Mesh("stale terrain", scene);
  const currentTerrain = new Mesh("current terrain", scene);
  const sharedMaterial = createTerrainMaterial(scene, { usesLandCoverTint: true });
  staleTerrain.material = sharedMaterial;
  currentTerrain.material = sharedMaterial;

  disposeTerrainMesh(staleTerrain);

  assert.ok(staleTerrain.isDisposed());
  assert.ok(!currentTerrain.isDisposed());
  assert.equal(currentTerrain.material, sharedMaterial);
  assert.ok(scene.materials.includes(sharedMaterial));
  assert.equal(scene.textures.length, 3);

  scene.dispose();
  engine.dispose();
});
