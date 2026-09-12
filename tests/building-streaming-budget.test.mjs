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

test("both detail levels render one composite across provider tiles", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const outer = [[0.355, 0.425], [0.3552, 0.425], [0.3552, 0.4252], [0.355, 0.4252], [0.355, 0.425]];
  const tiles = [0, 1].map((index) => ({ x: index, y: 0, zoom: 14, data: { layers: { building: {
    length: 1,
    feature: () => ({ id: index, properties: { render_height: 6 + index * 3 },
      toGeoJSON: () => ({ geometry: { type: "Polygon", coordinates: [outer.map(([x, y]) => [x + index * 0.0001, y])] } }),
    }),
  } } } }));
  const originalDetailed = ProceduralBuildingRenderer.createDetailed;
  const originalFar = ProceduralBuildingRenderer.createFar;
  const plans = [];
  try {
    const render = (_scene, plan, _terrain, options) => {
      plans.push(plan);
      assert.equal(options.neighboringBuildingFootprints.length, 1);
      return MeshBuilder.CreateBox("composite", {}, scene);
    };
    ProceduralBuildingRenderer.createDetailed = render;
    ProceduralBuildingRenderer.createFar = render;
    for (const detail of ["far", "detailed"]) {
      const layer = await OpenStreetMap.createBuildingLayer(scene, tiles, {
        worldTile: buildingOwnerWorldTile({ outer, holes: [] }, 14),
      }, { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 }, detail);
      assert.equal(layer.count, 1);
    }
    assert.equal(plans.length, 2);
    assert.deepEqual(plans[0], plans[1]);
    assert.equal(plans[0].heightMeters, 9);
    assert.ok(plans[0].id.startsWith("composite:"));
  } finally {
    ProceduralBuildingRenderer.createDetailed = originalDetailed;
    ProceduralBuildingRenderer.createFar = originalFar;
    scene.dispose();
    engine.dispose();
  }
});

test("dense building layers flush merge batches and keep every building detailed", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const outer = [[0.355, 0.425], [0.3551, 0.425], [0.3551, 0.4251], [0.355, 0.4251], [0.355, 0.425]];
  const tile = { x: 0, y: 0, zoom: 14, data: { layers: { building: {
    length: 16,
    feature: (id) => ({ id, properties: {},
      // Distinct footprints: coincident polygons now correctly become one composite.
      toGeoJSON: () => ({ geometry: { type: "Polygon", coordinates: [outer.map(([x, y]) => [x + id * 0.0002, y])] } }),
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
