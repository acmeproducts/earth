import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const water = readFileSync(new URL("../src/Water.ts", import.meta.url), "utf8");
const worldCover = readFileSync(new URL("../src/WorldCover.ts", import.meta.url), "utf8");
const terrainData = readFileSync(new URL("../src/TerrainData.ts", import.meta.url), "utf8");

test("flat water does not carry a redundant triangle grid", () => {
  assert.match(water, /subdivisions = 1/);
  assert.match(water, /\{ width: width \* 1\.2, height: height \* 1\.2, subdivisions \}/);
});

test("the two wave layers cannot reinforce an aligned square repeat", () => {
  const ratio = Number(water.match(/const CHOP_TILE_RATIO = ([\d.]+)/)?.[1]);
  assert.ok(Number.isFinite(ratio));
  assert.notEqual(ratio, Math.round(ratio));
  assert.match(water, /swell\.uOffset = 0\.173/);
  assert.match(water, /chop\.uOffset = 0\.631/);
});

test("ocean and inland meshes can share the PBR water surface implementation", () => {
  assert.match(water, /export function createWaterSurfaceMaterial/);
  assert.match(water, /export function prepareWaterSurfaceMesh/);
  assert.match(water, /new PBRMaterial\(name, scene\)/);
});

test("water waits for alpha-cut foliage depth before writing SSR reflectivity", () => {
  assert.match(water, /water\.transparencyMode = Material\.MATERIAL_ALPHATEST/);
});

test("separately streamed water materials animate in phase", () => {
  assert.match(water, /const seconds = performance\.now\(\) \/ 1000/);
  assert.doesNotMatch(water, /seconds \+= scene\.getEngine\(\)\.getDeltaTime\(\)/);
});

test("water motion is zero at calm wind and grows sublinearly", () => {
  assert.match(water, /export function waterMotionSpeed\(windStrength: number, exposure = 1\)/);
  assert.match(water, /Math\.sqrt\(strength \/ WATER_WIND_RESPONSE\)/);
  assert.doesNotMatch(water, /Math\.max\(0\.15, wind\.strength\)/);
});

test("strong manual wind cannot expose the wave texture tile grid", () => {
  assert.match(water, /const MAX_WAVE_ROUGHNESS_WIND = 1/);
  assert.match(water, /const roughnessWind = Math\.min\(MAX_WAVE_ROUGHNESS_WIND, wind\.strength\)/);
  assert.doesNotMatch(water, /0\.72 \+ wind\.strength \* 0\.28/);
  assert.doesNotMatch(water, /0\.78 \+ wind\.strength \* 0\.22/);
});

test("retains the terrain water mask for coastline shaping and bridge clearance", () => {
  assert.match(terrainData, /waterMask\?: Uint8Array/);
  assert.match(worldCover, /terrain\.waterMask = cropWaterMask\(/);
  assert.match(worldCover, /shapeCoastlineElevations\([\s\S]*coverage,[\s\S]*water,/);
});
