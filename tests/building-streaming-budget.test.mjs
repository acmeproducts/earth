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
    // Node 23's synchronous hooks need explicit source for Yarn's archived CJS.
    if (context.format === "commonjs" || url.endsWith(".cjs.js") || url.endsWith(".cjs")) return {
      format: "commonjs", shortCircuit: true, source: readFileSync(new URL(url), "utf8"),
    };
    return nextLoad(url, context);
  },
});
const { OpenStreetMap } = await import("../src/world/OpenStreetMap.ts");
hook.deregister();
const { ProceduralBuildingRenderer } = await import("../src/procedural/ProceduralBuildingRenderer.ts");
const { buildingOwnerWorldTile } = await import("../src/buildings/BuildingTileOwnership.ts");
const { planRoadsAndBuildings } = await import("../src/roads/RoadAndBuildingPlanner.ts");
const { planRoad } = await import("../src/roads/RoadPlanner.ts");
const { TerrainSurface } = await import("../src/terrain/TerrainSurface.ts");
const { BuildingTrace } = await import("../src/buildings/BuildingDiagnostics.ts");
const { runBuildingComposition } = await import("../src/buildings/BuildingCompositionTask.ts");

test("road tiles share scene-owned materials and keep neighbors alive on disposal", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const terrain = { width: 2, height: 2, elevations: new Float32Array(4),
      bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 }, groundWidthMeters: 100 };
    const options = { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 };
    const planning = planRoadsAndBuildings([{ id: 'road',
      paths: [[{ x: -40, z: 0 }, { x: 40, z: 0 }]], appearance: planRoad({ class: 'minor' }),
    }], [], options);
    const first = await OpenStreetMap.createRoadLayer(scene, [], terrain, { ...options, planning });
    const second = await OpenStreetMap.createRoadLayer(scene, [], terrain, { ...options, planning });
    assert.ok(first.meshes.length > 0);
    const material = first.meshes[0].material;
    const texture = material.diffuseTexture;
    assert.equal(second.meshes[0].material, material);
    assert.ok(material.pluginManager.getPlugin('SnowCover'));
    OpenStreetMap.disposeLayer(first.root);
    assert.equal(second.meshes[0].material, material);
    assert.ok(scene.materials.includes(material));
    assert.ok(scene.textures.includes(texture));
    const third = await OpenStreetMap.createRoadLayer(scene, [], terrain, { ...options, planning });
    assert.equal(third.meshes[0].material, material);
    OpenStreetMap.disposeLayer(second.root);
    OpenStreetMap.disposeLayer(third.root);
    assert.ok(scene.materials.includes(material), 'the scene retains reusable materials between tile visits');
    scene.dispose();
    assert.equal(scene.materials.length, 0);
    assert.equal(scene.textures.length, 0);
  } finally { scene.dispose(); engine.dispose(); }
});

test("planned roads and shoulders yield without changing geometry or exposing partial batches", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const terrain = { width: 2, height: 2, elevations: new Float32Array(4),
      bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 }, groundWidthMeters: 100 };
    const options = { meshWidth: 100, meshDepth: 100, metersPerUnit: 1,
      terrainSurface: new TerrainSurface(Float32Array.from({ length: 17 * 17 }, (_, i) => Math.sin(i) * .1), 16, 100, 100) };
    const planning = planRoadsAndBuildings(['primary', 'minor'].map((roadClass, i) => ({
      id: String(i), paths: [[{ x: -40, z: i * 20 }, { x: 40, z: i * 20 }]],
      appearance: planRoad({ class: roadClass }),
    })), [], options);
    const data = layer => layer.meshes.map(mesh => ({
      positions: Array.from(mesh.getVerticesData('position')), indices: Array.from(mesh.getIndices()),
      uvs: Array.from(mesh.getVerticesData('uv')), normals: Array.from(mesh.getVerticesData('normal')),
    }));
    for (const create of [OpenStreetMap.createLayer, OpenStreetMap.createRoadLayer]) {
      const first = await create.call(OpenStreetMap, scene, [], terrain, { ...options, planning });
      const expected = data(first);
      OpenStreetMap.disposeLayer(first.root);
      let yields = 0;
      const second = await create.call(OpenStreetMap, scene, [], terrain, { ...options, planning }, async () => {
        yields++;
        assert.ok(scene.meshes.every(mesh => !mesh.isEnabled()));
      });
      assert.ok(yields > planning.roads.length, 'yield within polygon batches, not only between styles');
      assert.deepEqual(data(second), expected);
      OpenStreetMap.disposeLayer(second.root);
      await assert.rejects(create.call(OpenStreetMap, scene, [], terrain, { ...options, planning }, async () => {
        if (scene.meshes.length) throw new Error('cancel construction');
      }), /cancel construction/);
      assert.equal(scene.meshes.length, 0, 'dispose previously completed styles after cancellation');
      assert.equal(scene.transformNodes.length, 0, 'dispose incomplete layer root');
    }
  } finally { scene.dispose(); engine.dispose(); }
});

test("lake preparation passes raw overlapping footprints without building-use inference", () => {
  const ring = [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.4, 0.4]];
  const tile = { x: 0, y: 0, zoom: 14, data: { layers: {
    water: { length: 1, feature: () => ({ id: 1, properties: {}, toGeoJSON: () => ({ geometry: { type: 'Polygon', coordinates: [ring] } }) }) },
    building: { length: 2, feature: id => ({ id, properties: {}, toGeoJSON: () => ({ geometry: { type: 'Polygon', coordinates: [ring] } }) }) },
    poi: { get length() { throw new Error('lake filtering must not infer building use'); } },
  } } };
  const input = OpenStreetMap.prepareLakeCollection([tile], {
    bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 }, groundWidthMeters: 100,
  }, { meshWidth: 100, meshDepth: 100 });
  assert.equal(input.candidates.length, 1);
  assert.equal(input.buildings.length, 2);
  assert.deepEqual(input.buildings[0], input.buildings[1]);
});

test("lake obstacle culling retains off-tile overlap and carriageway edges", () => {
  const box = (left, right) => [[left, .4], [right, .4], [right, .6], [left, .6], [left, .4]];
  const buildings = [box(1.2, 1.3), box(2, 3)];
  const roads = [1.52, 2, 1.25];
  const tile = { x: 0, y: 0, zoom: 14, data: { layers: {
    water: { length: 1, feature: () => ({ id: 1, properties: {}, toGeoJSON: () => ({ geometry: { type: 'Polygon', coordinates: [box(.4, 1.5)] } }) }) },
    building: { length: buildings.length, feature: id => ({ id, properties: {}, toGeoJSON: () => ({ geometry: { type: 'Polygon', coordinates: [buildings[id]] } }) }) },
    transportation: { length: roads.length, feature: id => ({ id, properties: { class: 'minor', ...(id === 2 ? { brunnel: 'bridge' } : {}) }, toGeoJSON: () => ({ geometry: { type: 'LineString', coordinates: [[roads[id], .3], [roads[id], .7]] } }) }) },
  } } };
  const terrain = { bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 }, groundWidthMeters: 100 };
  for (const size of [100, 50]) {
    const input = OpenStreetMap.prepareLakeCollection([tile], terrain, { meshWidth: size, meshDepth: size });
    assert.equal(input.candidates.length, 1);
    assert.equal(input.buildings.length, 1, 'obstacle outside the tile still overlaps the full lake');
    assert.ok(input.buildings[0].outline.every(p => p.x > size / 2));
    assert.equal(input.roads.length, 1, 'retain the road whose edge reaches the lake; omit distant roads and bridges');
    assert.ok(input.roads[0].paths[0].every(p => p.x > input.candidates[0].water.outline[1].x));
  }
});

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
  const originalTrace = BuildingTrace.run;
  let compositions = 0;
  BuildingTrace.run = function(label, ...args) {
    if (label.startsWith("provider tiles=") && label.endsWith(" sources")) compositions++;
    return originalTrace.call(this, label, ...args);
  };
  try {
    const render = (_scene, plan, _terrain, options) => {
      plans.push(plan);
      assert.equal(options.neighboringBuildingFootprints.length, 1);
      return MeshBuilder.CreateBox("composite", {}, scene);
    };
    ProceduralBuildingRenderer.createDetailed = render;
    ProceduralBuildingRenderer.createFar = render;
    let workerCalls = 0;
    const compose = async sources => {
      workerCalls++;
      return structuredClone(runBuildingComposition(structuredClone(sources)).result);
    };
    await Promise.all([
      OpenStreetMap.prepareBuildingComposition(tiles, compose),
      OpenStreetMap.prepareBuildingComposition(tiles.map(tile => ({ ...tile })), compose),
    ]);
    assert.equal(workerCalls, 1, "concurrent requests share worker composition");
    for (const detail of ["far", "detailed"]) {
      const layer = await OpenStreetMap.createBuildingLayer(scene, tiles.map(tile => ({ ...tile })), {
        worldTile: buildingOwnerWorldTile({ outer, holes: [] }, 14),
      }, { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 }, detail);
      assert.equal(layer.count, 1);
    }
    assert.equal(plans.length, 2);
    assert.deepEqual(plans[0], plans[1]);
    assert.equal(plans[0].heightMeters, 9);
    assert.ok(plans[0].id.startsWith("composite:"));
    assert.equal(compositions, 0, "rendering must reuse worker output without synchronous composition");
  } finally {
    BuildingTrace.run = originalTrace;
    ProceduralBuildingRenderer.createDetailed = originalDetailed;
    ProceduralBuildingRenderer.createFar = originalFar;
    scene.dispose();
    engine.dispose();
  }
});

test("failed composition can be retried without caching incomplete output", async () => {
  const tiles = [{ x: 0, y: 0, zoom: 14, data: { layers: {} } }];
  await assert.rejects(OpenStreetMap.prepareBuildingComposition(tiles, async () => { throw new Error("cancelled"); }), /cancelled/);
  let attempts = 0;
  await OpenStreetMap.prepareBuildingComposition(tiles, async () => { attempts++; return []; });
  await OpenStreetMap.prepareBuildingComposition(tiles, async () => { throw new Error("cached output lost"); });
  assert.equal(attempts, 1);
});

test("dense standalone and mixed map layers preserve batching, staging and detail", async () => {
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
      const mesh = MeshBuilder.CreateGround("detail", { subdivisions: 180 }, scene);
      mesh.setEnabled(false);
      return mesh;
    };
    ProceduralBuildingRenderer.createFar = () => {
      farCalls++;
      return MeshBuilder.CreateBox("mass", {}, scene);
    };
    const terrain = {
      worldTile: buildingOwnerWorldTile({ outer, holes: [] }, 14),
      bounds: { lonWest: 0.35, lonEast: 0.36, latSouth: 0.42, latNorth: 0.43 },
    };
    for (const mixed of [false, true]) {
      detailedCalls = yields = 0;
      const options = { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 };
      const yieldControl = async () => {
        yields++;
        assert.ok(scene.meshes.every((mesh) => !mesh.isEnabled()), "no building flashes during a yield");
      };
      const layer = mixed
        ? await OpenStreetMap.createLayer(scene, [tile], terrain, options, yieldControl)
        : await OpenStreetMap.createBuildingLayer(scene, [tile], terrain, options, "detailed", yieldControl);
      assert.equal(mixed ? layer.counts.buildings : layer.count, 16);
      assert.equal(detailedCalls, 16);
      assert.equal(farCalls, 0);
      assert.equal(layer.meshes.length, 16);
      assert.ok(yields >= 32);
      assert.ok(layer.meshes.every((mesh) => mesh.parent === layer.root && mesh.isEnabled()));
      assert.ok(layer.meshes.every((mesh) => mesh.checkCollisions));
      OpenStreetMap.disposeLayer(layer.root);
    }
  } finally {
    ProceduralBuildingRenderer.createDetailed = originalDetailed;
    ProceduralBuildingRenderer.createFar = originalFar;
    scene.dispose();
    engine.dispose();
  }
});
