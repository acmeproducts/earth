import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const field = readFileSync(new URL("../src/RockyBeachField.ts", import.meta.url), "utf8");
const impostor = readFileSync(
  new URL("../src/RockyBeachImpostor.ts", import.meta.url),
  "utf8",
);
const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");

test("captures a dense procedural rocky-beach patch through the impostor pipeline", () => {
  assert.match(impostor, /createImpostorAssetProvider/);
  assert.match(impostor, /queryPrefix: "rocky-beach-impostor"/);
  assert.match(impostor, /STONE_COUNT = 480/);
  assert.match(impostor, /CreateIcoSphere/);
  assert.match(impostor, /createVertexColorCaptureMaterial/);
  assert.match(impostor, /upperHemisphereOnly: true/);
});

test("selects coherent natural shoreline stretches for rocky beaches", () => {
  assert.match(field, /rockyBeachCharacter\(location\.lon, location\.lat/);
  assert.match(field, /cover === LandCoverClass\.Bare/);
  assert.match(field, /shoreNeighbours\.water === 0/);
  assert.match(field, /threshold = mappedRockySurface \? 0\.24 : 0\.62/);
  assert.match(field, /isTerrainFootprintAbove/);
  assert.match(field, /normal\.y < 0\.78/);
});

test("uses a broader, more detailed rocky shoreline treatment", () => {
  assert.match(field, /ROCK_PATCH_SPACING_METERS = 3/);
  assert.match(field, /SHORE_PROBE_METERS = 24/);
  assert.match(field, /ROCK_WATER_FOOTPRINT_ALLOWANCE_METERS = 1\.6/);
  assert.doesNotMatch(field, /SUBMERGED_PATCH_DEPTH_METERS|groundedElevation/);
  assert.match(field, /\(elevation \+ ROCK_GROUND_OFFSET_METERS\)/);
  assert.match(field, /depth: \{ groundPlaneHeight: 0\.08 \/ metersPerUnit \}/);
  assert.match(field, /submerged \? shoreNeighbours\.land === 0/);
  assert.match(impostor, /CAPTURE_DIAMETER = 6\.2/);
  assert.match(impostor, /resolution: \{ default: 192/);
  assert.match(impostor, /const strata = Math\.sin/);
  assert.match(impostor, /const fleck = Math\.sin/);
  assert.doesNotMatch(impostor, /const seam = Math\.abs/);
  assert.match(impostor, /rockTextureStrength", 1/);
});

test("streams rocky-beach impostors as a normal detailed field", () => {
  assert.match(game, /createRockyBeachField\(this\.scene, terrainData/);
  assert.match(game, /"rockyBeachField"/);
});

test("restores contrast lost when stone normals are flattened into an impostor", () => {
  assert.match(field, /impostorColorContrast: 1\.2/);
  assert.doesNotMatch(field, /model\.material\.setFloat\("impostorColorContrast"/);
});
