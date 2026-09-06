import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "lerc") return {
      url: "data:text/javascript,export function decode(){throw new Error('Unexpected raster decode')} export function load(){throw new Error('Unexpected raster load')}",
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) return {
      format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }),
    };
    return nextLoad(url, context);
  },
});
const { NullEngine, Scene, Mesh, VertexBuffer } = await import("@babylonjs/core");
const { applyDefaultTerrainMaterial, setTerrainSnowCovered } = await import("../src/TerrainMesh.ts");
hook.deregister();

test("live seasons switch existing ground summer to winter and back without rebuilding", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const terrain = new Mesh("seasonal ground", scene);
    terrain.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0]);
    const colors = new Float32Array([0.2, 0.6, 0.1, 1]);
    terrain.metadata = { surfaceColors: colors, snowCovered: false };
    applyDefaultTerrainMaterial(scene, terrain);
    const summerMaterial = terrain.material;
    setTerrainSnowCovered(scene, terrain, true);
    assert.equal(terrain.material.name, "terrainMaterialSnow");
    assert.equal(terrain.useVertexColors, false);
    assert.equal(terrain.isDisposed(), false);

    setTerrainSnowCovered(scene, terrain, false);
    assert.equal(terrain.material, summerMaterial);
    assert.equal(terrain.useVertexColors, true);
    assert.deepEqual(terrain.getVerticesData(VertexBuffer.ColorKind), colors);
    setTerrainSnowCovered(scene, terrain, false);
    assert.equal(terrain.material, summerMaterial);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
