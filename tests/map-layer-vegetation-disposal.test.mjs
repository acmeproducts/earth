import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { Mesh, MultiMaterial, NullEngine, PBRMaterial, RawTexture, Scene, ShaderMaterial, StandardMaterial, TransformNode } from "@babylonjs/core";

// Exercise the actual cleanup method without loading the browser-only map
// generation dependency graph (including enums unsupported by strip-only Node).
const source = readFileSync(new URL("../src/world/OpenStreetMap.ts", import.meta.url), "utf8");
const method = source.slice(source.indexOf("  static disposeLayer("), source.indexOf("  private static async fetchTile("));
const OpenStreetMap = new Function("ShaderMaterial", "MultiMaterial", "PBRMaterial", "StandardMaterial",
  `${stripTypeScriptTypes(`class MapCleanup { ${method} }`)}; return MapCleanup;`,
)(ShaderMaterial, MultiMaterial, PBRMaterial, StandardMaterial);

test("disposing a map layer preserves textures used by vegetation in other tiles", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const shared = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
    let sharedDisposals = 0;
    shared.onDisposeObservable.add(() => sharedDisposals++);
    const layer = new TransformNode("mapLayer", scene);
    const hedgeRoot = new TransformNode("hedgeRenderers", scene);
    hedgeRoot.parent = layer;
    const hedge = new Mesh("hedge", scene);
    hedge.parent = hedgeRoot;
    const material = new ShaderMaterial("hedgeMaterial", scene, "vegetation", {});
    material.setTexture("vegetationShadowSampler", shared);
    hedge.material = material;
    let materialDisposals = 0;
    material.onDisposeObservable.add(() => materialDisposals++);
    hedgeRoot.onDisposeObservable.addOnce(() => material.dispose(false, false));
    const neighbor = new Mesh("neighborVegetation", scene);
    neighbor.material = new ShaderMaterial("neighborMaterial", scene, "vegetation", {});
    neighbor.material.setTexture("vegetationShadowSampler", shared);
    const road = new Mesh("road", scene);
    road.parent = layer;
    road.material = new StandardMaterial("roadMaterial", scene);
    const roadTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
    road.material.diffuseTexture = roadTexture;
    let roadTextureDisposals = 0;
    roadTexture.onDisposeObservable.add(() => roadTextureDisposals++);

    OpenStreetMap.disposeLayer(layer);

    assert.equal(sharedDisposals, 0);
    assert.equal(materialDisposals, 1);
    assert.equal(roadTextureDisposals, 1);
    assert.equal(hedge.isDisposed(), true);
    assert.equal(hedgeRoot.isDisposed(), true);
    assert.equal(neighbor.isDisposed(), false);
    assert.ok(shared.getInternalTexture());
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
