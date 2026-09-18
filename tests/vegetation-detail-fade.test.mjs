import assert from "node:assert/strict";
import test from "node:test";
import { NullEngine, Scene, Mesh, ShaderMaterial } from "@babylonjs/core";
import { vegetationDistanceFadeRange } from "../src/vegetation/DistanceDropout.ts";
import { setVegetationFieldDetailDistance } from "../src/vegetation/VegetationMaterial.ts";

test("vegetation stays dense until the outer fifth of the circular detail range", () => {
  for (const size of [1, 2, 3, 9, 15]) {
    const fade = vegetationDistanceFadeRange(25, size);
    assert.equal(fade.far, 25 * size / 2);
    assert.equal(fade.near, fade.far * 0.8);
    assert.ok(fade.near > 0 && fade.near < fade.far);
  }
  assert.ok(vegetationDistanceFadeRange(25, 2).near > 25 * 0.35,
    "default grass starts fading later than the previous wide transition");
});

test("detail changes update both model and impostor fade uniforms", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const meshes = [new Mesh("model", scene), new Mesh("impostor", scene)];
    for (const mesh of meshes) mesh.material = new ShaderMaterial(mesh.name, scene, "test", {});
    const field = { modelMeshes: [meshes[0]], impostorMeshes: [meshes[1]] };
    for (const size of [2, 15, 3]) {
      setVegetationFieldDetailDistance(field, 25, size);
      const range = vegetationDistanceFadeRange(25, size);
      for (const mesh of meshes) {
        assert.equal(mesh.material._floats.distanceFadeNear, range.near);
        assert.equal(mesh.material._floats.distanceFadeFar, range.far);
      }
    }
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
