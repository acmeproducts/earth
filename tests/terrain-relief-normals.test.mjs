import assert from 'node:assert/strict';
import test from 'node:test';
import { NullEngine, Scene, Mesh, StandardMaterial } from '@babylonjs/core';
import { terrainReliefNormalPixels, attachTerrainReliefNormals, TerrainReliefNormalsPlugin } from '../src/terrain/TerrainReliefNormals.ts';

const raster = (fn) => ({ width: 5, height: 5, groundWidthMeters: 4, groundHeightMeters: 4,
  elevations: Float32Array.from({length: 25}, (_, i) => fn(i % 5, Math.floor(i / 5))) });

test('road grading and building pads preserve the surrounding sand material', () => {
  const data = raster(() => 100);
  data.sandCoverage = new Float32Array(25).fill(1);
  data.reliefReferenceElevations = data.elevations.slice();
  assert.equal(terrainReliefNormalPixels(data)[3], 255);
  // Road channel, raised foundation, and their graded shoulders.
  data.elevations.set([99, 99.75, 100, 100.25, 102]);
  const pixels = terrainReliefNormalPixels(data);
  for (let i = 0; i < 25; i++) assert.equal(pixels[i * 4 + 3], 255);
  data.sandCoverage[0] = 0.2;
  assert.equal(terrainReliefNormalPixels(data)[3], 102, 'retain blended land-cover boundaries');
  delete data.sandCoverage;
  assert.equal(terrainReliefNormalPixels(data)[3], 0);
});

test('normal map preserves physical slope and north/south orientation', () => {
  const pixels = terrainReliefNormalPixels(raster((x, y) => 100 + x * 0.3 + y * 0.4));
  const expected = [-0.3, 1, 0.4].map(v => v / Math.hypot(0.3, 1, 0.4));
  for (let i = 0; i < 25; i++) for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(pixels[i * 4 + axis] / 255 * 2 - 1 - expected[axis]) < 0.008);
  }
});

test('omitted geometric relief survives in shading, but carved surfaces suppress it', () => {
  const data = raster(() => 100);
  data.reliefReferenceElevations = data.elevations.slice();
  data.shadingRelief = Float32Array.from({length:25}, (_, i) => i % 5 * 0.3);
  assert.deepEqual(terrainReliefNormalPixels(data), terrainReliefNormalPixels(raster(x => 100 + x * 0.3)));
  data.elevations.fill(99);
  assert.deepEqual(terrainReliefNormalPixels(data), terrainReliefNormalPixels(raster(() => 99)));
});

test('normal maps belong to tiles and are released independently', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const first = new Mesh('first', scene), second = new Mesh('second', scene);
  attachTerrainReliefNormals(first, raster(() => 100), 4, 4);
  attachTerrainReliefNormals(second, raster(x => 100 + x), 4, 4);
  assert.equal(scene.textures.length, 2);
  first.dispose();
  assert.equal(scene.textures.length, 1);
  second.dispose();
  assert.equal(scene.textures.length, 0);
  scene.dispose(); engine.dispose();
});

test('skirts share parent sand shading and the common scene scale without another texture', () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  const ground = new Mesh('ground', scene), skirt = new Mesh('skirt', scene);
  skirt.parent = ground;
  attachTerrainReliefNormals(ground, raster(() => 100), 4, 4, 7);
  const plugin = new TerrainReliefNormalsPlugin(new StandardMaterial('test', scene));
  const defines = {};
  plugin.prepareDefines(defines, scene, skirt);
  assert.equal(defines.TERRAIN_RELIEF_NORMALS, true);
  const uniforms = {};
  plugin.hardBindForSubMesh({ updateFloat4() {}, setTexture(name, value) { uniforms[name] = value; },
    updateFloat(name, value) { uniforms[name] = value; } }, scene, engine, {getMesh: () => skirt});
  assert.equal(uniforms.terrainSandScale, 7);
  assert.equal(uniforms.terrainReliefNormals, scene.textures[0]);
  assert.equal(scene.textures.length, 1);
  scene.dispose(); engine.dispose();
});

test('fine ridges soften equally whether carried by geometry or shading relief', () => {
  const width = 49, height = 5;
  const relief = Float32Array.from({length: width * height}, (_, i) => Math.sin((i % width) * Math.PI / 3));
  const near = {width, height, groundWidthMeters: 48, groundHeightMeters: 4,
    elevations: Float32Array.from(relief, value => 100 + value)};
  const far = {...near, elevations: new Float32Array(width * height).fill(100), shadingRelief: relief};
  const nearPixels = terrainReliefNormalPixels(near), farPixels = terrainReliefNormalPixels(far);
  for (let i = 0; i < nearPixels.length; i++) assert.ok(Math.abs(nearPixels[i] - farPixels[i]) <= 1);
  const center = (2 * width + 24) * 4;
  const nx = nearPixels[center] / 255 * 2 - 1;
  const ny = nearPixels[center + 1] / 255 * 2 - 1;
  assert.ok(Math.abs(nx / ny + Math.sin(Math.PI / 3) * 0.25) < 0.01,
    'fine slope keeps quarter strength around the shared broad slope');
});
