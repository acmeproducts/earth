import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { MeshBuilder, NullEngine, Scene } from "@babylonjs/core";

// Match the terrain integration harness: transform its enum and reject any
// unexpected raster I/O in this entirely synthetic map fixture.
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "lerc") return {
      url: "data:text/javascript,export function decode(){throw new Error('Unexpected raster decode')} export function load(){throw new Error('Unexpected raster load')}",
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/WorldCover.ts")) return {
      format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }),
    };
    return nextLoad(url, context);
  },
});
const { OpenStreetMap } = await import("../src/OpenStreetMap.ts");
hook.deregister();
const { ProceduralBuildingRenderer } = await import("../src/procedural/ProceduralBuildingRenderer.ts");
const { buildingOwnerWorldTile } = await import("../src/BuildingTileOwnership.ts");

test("dense building layers flush merge batches and keep every building detailed", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const outer = [[0.35, 0.42], [0.65, 0.42], [0.65, 0.58], [0.35, 0.58], [0.35, 0.42]];
  const tile = { x: 0, y: 0, zoom: 14, data: { layers: { building: {
    length: 16,
    feature: (id) => ({ id, properties: {},
      toGeoJSON: () => ({ geometry: { type: "Polygon", coordinates: [outer] } }),
    }),
  } } } };
  const originalDetailed = ProceduralBuildingRenderer.createDetailed;
  const originalFar = ProceduralBuildingRenderer.createFar;
  let detailedCalls = 0;
  let farCalls = 0;
  let yields = 0;
  try {
    // Known-size real buffers isolate the streaming policy from room planning.
    ProceduralBuildingRenderer.createDetailed = () => {
      detailedCalls++;
      return MeshBuilder.CreateGround("detail", { subdivisions: 180 }, scene);
    };
    ProceduralBuildingRenderer.createFar = () => {
      farCalls++;
      return MeshBuilder.CreateBox("mass", {}, scene);
    };
    const layer = await OpenStreetMap.createBuildingLayer(scene, [tile], {
      worldTile: buildingOwnerWorldTile({ outer, holes: [] }, 14),
    }, { meshWidth: 100, meshDepth: 100, metersPerUnit: 1, startDisabled: true },
    "detailed", async () => { yields++; });
    assert.equal(layer.count, 16);
    assert.equal(detailedCalls, 16);
    assert.equal(farCalls, 0);
    assert.equal(layer.meshes.length, 16);
    assert.ok(yields >= 32);
    assert.ok(layer.meshes.every((mesh) => mesh.parent === layer.root && !mesh.isEnabled()));
    assert.ok(layer.meshes.every((mesh) => mesh.checkCollisions));
  } finally {
    ProceduralBuildingRenderer.createDetailed = originalDetailed;
    ProceduralBuildingRenderer.createFar = originalFar;
    scene.dispose();
    engine.dispose();
  }
});
