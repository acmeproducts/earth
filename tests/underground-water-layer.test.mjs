import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { NullEngine, Scene, RawTexture, ShaderLanguage } from "@babylonjs/core";

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
    if (context.format === 'commonjs' || url.endsWith('.cjs.js') || url.endsWith('.cjs')) return {
      format: 'commonjs', shortCircuit: true, source: readFileSync(new URL(url), 'utf8'),
    };
    return nextLoad(url, context);
  },
});
const { OpenStreetMap } = await import("../src/world/OpenStreetMap.ts");
hook.deregister();

test('sea, valley and river bridges share a joined profile and solid deck at both detail levels', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    for (const kind of ['sea', 'valley', 'river']) for (const metersPerUnit of [1, 10]) {
      const feature = (properties, coordinates) => ({ id: 1, properties,
        toGeoJSON: () => ({ geometry: { type: 'LineString', coordinates } }) });
      const tile = { x: 0, y: 0, zoom: 14, data: { layers: {
        transportation: { length: 1, feature: () => feature({ class: 'secondary', brunnel: 'bridge' }, [[0, .5], [1, .5]]) },
        ...(kind === 'river' ? { waterway: { length: 1, feature: () => feature({ class: 'river' }, [[.5, 0], [.5, 1]]) } } : {}),
      } } };
      const elevations = Float32Array.from({ length: 33 * 33 }, (_, i) => {
        const distance = Math.abs(i % 33 - 16) / 16;
        return kind === 'river' ? 10 : (kind === 'sea' ? -8 : 2) + distance * distance * (kind === 'sea' ? 28 : 18);
      });
      const terrain = { bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 },
        width: 33, height: 33, elevations, minElevation: -8, maxElevation: 20,
        groundWidthMeters: 100, groundHeightMeters: 100 };
      const options = { meshWidth: 100 / metersPerUnit, meshDepth: 100 / metersPerUnit, metersPerUnit,
        preCarvingElevations: new Float32Array(33 * 33).fill(80) };
      const detailed = await OpenStreetMap.createLayer(scene, [tile], terrain, options);
      const distant = await OpenStreetMap.createRoadLayer(scene, [tile], terrain, options);
      const surface = detailed.meshes.find(mesh => mesh.name === 'markedRoads').getVerticesData('position');
      const far = distant.meshes.find(mesh => mesh.name === 'farMarkedRoads').getVerticesData('position');
      assert.deepEqual([...far], [...surface], `${kind}: no profile jump between detail levels`);
      const heights = Array.from(surface).filter((_, index) => index % 3 === 1).map(y => y * metersPerUnit);
      const approach = kind === 'river' ? 10.025 : 20.025;
      assert.ok(Math.abs(heights[0] - approach) < 1e-4, `${kind}: land endpoint remains joined`);
      const deck = detailed.meshes.find(mesh => mesh.name === 'bridgeDecks').getVerticesData('position');
      const deckHeights = Array.from(deck).filter((_, index) => index % 3 === 1).map(y => y * metersPerUnit);
      assert.ok(deckHeights.every(Number.isFinite));
      assert.ok(deckHeights.some(y => Math.abs(y - (approach - .025)) < 1e-4), 'slab top meets road');
      assert.ok(deckHeights.some(y => Math.abs(y - (approach - .345)) < 1e-4), 'slab has thickness');
      if (kind === 'river') {
        const river = detailed.meshes.find(mesh => mesh.name === 'waterways').getVerticesData('position');
        const waterHeight = Math.max(...Array.from(river).filter((_, index) => index % 3 === 1)) * metersPerUnit;
        for (let i = 0; i < deck.length; i += 3) {
          if (Math.abs(deck[i] * metersPerUnit) < 2) assert.ok(deck[i + 1] * metersPerUnit >= waterHeight + .119);
        }
      }
      OpenStreetMap.disposeLayer(detailed.root);
      OpenStreetMap.disposeLayer(distant.root);
    }
  } finally { scene.dispose(); engine.dispose(); }
});

test('planned and distant road crossings both stay above the river surface', async () => {
  const { TerrainSurface } = await import('../src/terrain/TerrainSurface.ts');
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const feature = (properties, coordinates) => ({ id: 1, properties,
    toGeoJSON: () => ({ geometry: { type: 'LineString', coordinates } }) });
  const tile = { x: 0, y: 0, zoom: 14, data: { layers: {
    waterway: { length: 1, feature: () => feature({ class: 'river' }, [[0.5, 0], [0.5, 1]]) },
    transportation: { length: 1, feature: () => feature({ class: 'secondary' }, [[0, 0.5], [1, 0.5]]) },
  } } };
  const terrain = { bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 },
    width: 9, height: 9, elevations: new Float32Array(81).fill(10),
    minElevation: 10, maxElevation: 10, groundWidthMeters: 40, groundHeightMeters: 40 };
  const options = { meshWidth: 40, meshDepth: 40, metersPerUnit: 1,
    terrainSurface: new TerrainSurface(terrain.elevations, 8, 40, 40) };
  options.planning = OpenStreetMap.planRoadsAndBuildings([tile], terrain, options);
  try {
    const detailed = await OpenStreetMap.createLayer(scene, [tile], terrain, options);
    const distant = await OpenStreetMap.createRoadLayer(scene, [tile], terrain, options);
    const river = detailed.meshes.find(mesh => mesh.name === 'waterways').getVerticesData('position');
    const waterHeight = river[1];
    for (const [layer, name] of [[detailed, 'markedRoads'], [distant, 'farMarkedRoads']]) {
      const positions = layer.meshes.find(mesh => mesh.name === name).getVerticesData('position');
      let crossingVertices = 0;
      for (let i = 0; i < positions.length; i += 3) {
        if (Math.abs(positions[i]) >= 6) continue;
        crossingVertices++;
        assert.ok(positions[i + 1] > waterHeight + 0.11, `${name} must clear water`);
      }
      assert.ok(crossingVertices > 0);
      OpenStreetMap.disposeLayer(layer.root);
    }
  } finally { scene.dispose(); engine.dispose(); }
});

test("streamed rivers retain their shared material, smooth normals and moving current", async () => {
  const { TerrainSurface } = await import('../src/terrain/TerrainSurface.ts');
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const sky = RawTexture.CreateRGBATexture(new Uint8Array([40, 80, 120, 255]), 1, 1, scene);
  const tile = { x: 0, y: 0, zoom: 14, data: { layers: {
    waterway: { length: 1, feature: () => ({ id: 2, properties: { class: 'river' },
      toGeoJSON: () => ({ geometry: { type: 'LineString', coordinates: [[0.2, 0.2], [0.5, 0.5], [0.8, 0.7]] } }),
    }) },
  } } };
  const terrain = { bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 },
    width: 3, height: 3, elevations: Float32Array.from([14, 13, 12, 12, 11, 10, 10, 9, 8]),
    minElevation: 8, maxElevation: 14, groundWidthMeters: 40, groundHeightMeters: 40 };
  const surface = new TerrainSurface(terrain.elevations, 2, 40, 40);
  const options = { meshWidth: 40, meshDepth: 40, metersPerUnit: 1, terrainSurface: surface, skyReflection: sky };
  try {
    const first = await OpenStreetMap.createLayer(scene, [tile], terrain, options);
    const second = await OpenStreetMap.createLayer(scene, [tile], terrain, options);
    const mesh = second.meshes.find(mesh => mesh.name === 'waterways');
    const material = mesh.material;
    assert.equal(first.meshes.find(mesh => mesh.name === 'waterways').material, material);
    const positions = mesh.getVerticesData('position');
    const normals = mesh.getVerticesData('normal');
    const tangents = mesh.getVerticesData('tangent');
    for (let index = 0; index < positions.length / 3; index++) {
      assert.ok(normals[index * 3 + 1] > 0.95);
      if (index % 2 === 0) {
        assert.equal(positions[index * 3 + 1], positions[(index + 1) * 3 + 1],
          'Both river banks must share one surface height');
        assert.deepEqual(normals.slice(index * 3, index * 3 + 3),
          normals.slice(index * 3 + 3, index * 3 + 6));
      }
      assert.ok(Math.abs(normals[index * 3] * tangents[index * 4] +
        normals[index * 3 + 1] * tangents[index * 4 + 1] +
        normals[index * 3 + 2] * tangents[index * 4 + 2]) < 1e-6);
    }
    const plugin = material.pluginManager.getPlugin('WaterMotion');
    for (const language of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) {
      assert.ok(!plugin.getCustomCode('vertex', language).CUSTOM_VERTEX_UPDATE_POSITION.includes('uvUpdated ='));
    }
    scene.onBeforeRenderObservable.notifyObservers(scene);
    const offset = material.bumpTexture.vOffset;
    await new Promise(resolve => setTimeout(resolve, 20));
    scene.incrementRenderId();
    // A new render frame makes the shared water clock advance.
    scene.getFrameId = () => 2;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    assert.ok(material.bumpTexture.vOffset < offset);
    OpenStreetMap.disposeLayer(first.root);
    assert.ok(scene.materials.includes(material));
    assert.equal(material.reflectionTexture, sky);
    assert.ok(material.bumpTexture.getScene());
    OpenStreetMap.disposeLayer(second.root);
    assert.ok(!scene.materials.includes(material));
    assert.ok(sky.getScene());
  } finally { scene.dispose(); engine.dispose(); }
});

test("underground Oslo river tags produce no surface ribbon or lake terrain source", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const coordinates = [[10.751, 59.911], [10.759, 59.919]];
  const properties = { name: "Akerselva", class: "river", intermittent: 0, brunnel: "tunnel" };
  const tile = { x: 8681, y: 4766, zoom: 14, data: { layers: {
    waterway: { length: 1, feature: () => ({ id: 644951252, properties,
      toGeoJSON: () => ({ geometry: { type: "LineString", coordinates } }),
    }) },
    water: { length: 1, feature: () => ({ id: 1, properties,
      toGeoJSON: () => ({ geometry: { type: "Polygon", coordinates: [[
        coordinates[0], [10.759, 59.911], coordinates[1], [10.751, 59.919], coordinates[0],
      ]] } }),
    }) },
  } } };
  const terrain = {
    bounds: { lonWest: 10.75, lonEast: 10.76, latSouth: 59.91, latNorth: 59.92 },
    width: 3, height: 3, groundWidthMeters: 560, groundHeightMeters: 1110,
    elevations: new Float32Array(9).fill(10), minElevation: 10, maxElevation: 10,
  };
  try {
    const layer = await OpenStreetMap.createLayer(scene, [tile], terrain,
      { meshWidth: 560, meshDepth: 1110, metersPerUnit: 1 });
    assert.equal(layer.counts.water, 0);
    assert.deepEqual(layer.lakePolygons, []);
    assert.deepEqual(layer.meshes, []);
    assert.equal(scene.meshes.length, 0);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
