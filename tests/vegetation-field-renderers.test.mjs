import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { Matrix, MeshBuilder, NullEngine, Scene, StandardMaterial, TransformNode } from "@babylonjs/core";

// Atlas capture is GPU work; supply its mesh while exercising the real field lifecycle.
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./TreeField" && context.parentURL?.endsWith("/VegetationFieldRenderers.ts")) return {
    shortCircuit: true,
    url: "data:text/javascript,export function createImpostorPrototypeFromAssets(scene,assets,height,root){assets.mesh.parent=root;return {mesh:assets.mesh,captureSize:height};}",
  };
  return next(specifier, context);
} });
const { createRegionalVegetationField } = await import("../src/vegetation/VegetationFieldRenderers.ts");
hook.deregister();

test("regional fields preserve placements, tints, staging and lease ownership", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const root = new TransformNode("field", scene);
  root.setEnabled(false);
  const buckets = [0, 1].map((localVariant) => ({
    variant: { regionX: 2, regionY: 3 }, localVariant,
    matrices: [Matrix.Translation(localVariant * 10, 0, 0)],
    colors: localVariant ? [] : [0.5, 0.25, 0.75],
  }));
  const placements = new Float32Array(buckets.flatMap((bucket) => [...bucket.matrices[0].m]));
  let releases = 0, materialsDisposed = 0, yields = 0;
  const suffixes = [];
  try {
    const field = await createRegionalVegetationField(scene, root, buckets, placements,
      { metersPerUnit: 1, renderMode: "models", yieldControl: async () => { yields++; } },
      (_bucket, suffix) => {
        suffixes.push(suffix);
        return {
          rootName: suffix, impostorName: suffix, renderHeight: 1,
          loadAssets: async () => ({ assets: { mesh: MeshBuilder.CreateBox("impostor", {}, scene) },
            release: () => { releases++; } }),
          createModel: () => {
            const mesh = MeshBuilder.CreateBox("model", {}, scene);
            mesh.material = new StandardMaterial("model", scene);
            mesh.material.onDisposeObservable.add(() => { materialsDisposed++; });
            return mesh;
          },
          configure: (impostor, model) => { impostor.metadata = model.metadata = "configured"; },
        };
      });
    assert.deepEqual(suffixes, ["2-3", "2-3-v1"]);
    assert.equal(field.count, 2);
    assert.equal(field.instanceMatrices, placements);
    assert.ok(yields > 0);
    assert.ok(field.meshes.every((mesh) => !mesh.isEnabled() && mesh.metadata === "configured"));
    assert.deepEqual(field.modelMeshes.map((mesh) => mesh.thinInstanceGetWorldMatrices()[0].m[12]), [0, 10]);
    assert.deepEqual(field.modelMeshes.map((mesh) => [...mesh._userThinInstanceBuffersStorage.data.vegetationColor]),
      [[0.5, 0.25, 0.75], [1, 1, 1]]);
    assert.equal(releases, 0);
    root.dispose(false, false);
    assert.equal(releases, 2);
    assert.equal(materialsDisposed, 2);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
