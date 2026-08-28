import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/RockField.ts", import.meta.url), "utf8");
const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");

test("builds deterministic bare and mossy thin-instanced rock variants", () => {
  assert.match(source, /createSeededRandom\(seed\)/);
  assert.match(source, /ROCK_VARIANTS \* 2/);
  assert.match(source, /mossy \? "mossy" : "bare"/);
  assert.match(source, /thinInstanceSetBuffer/);
  assert.match(source, /VertexBuffer\.ColorKind/);
  assert.match(source, /subdivisions: 2, flat: false/);
  assert.match(source, /VertexData\.ComputeNormals\(positions, indices, normals\)/);
});

test("shore rocks form long dense chains aligned to the water boundary", () => {
  assert.match(source, /function shorelineDirection/);
  assert.match(source, /tangentX: -waterZ \/ length/);
  assert.match(source, /lengthMeters = 12 \+ random\(\) \* 18/);
  assert.match(source, /count = Math\.max\(6, Math\.round\(lengthMeters \/ spacingMeters\)\)/);
  assert.match(source, /shoreNoise\.sample/);
  assert.match(source, /do not mix in the even inland scatter/);
});

test("keeps the general grassland rock scatter sparse", () => {
  assert.match(source, /\[LandCoverClass\.Grassland\]: 0\.015/);
  assert.match(source, /const habitat = habitatField\("rocks", modelVariantSeed, HABITAT\)/);
  assert.match(source, /const stand = habitat\.sample\(lon, lat\)/);
  assert.match(source, /const STONY_FLOOR = 0\.4/);
  assert.match(source, /if \(field <= 0\) continue/);
});

test("rocks retain burial and upward-facing moss decisions", () => {
  assert.match(source, /deepSet \? 0\.72 \+ random\(\) \* 0\.16/);
  assert.match(source, /: 0\.38 \+ random\(\) \* 0\.28/);
  assert.match(source, /upward > 0\.35/);
  assert.match(source, /exclusionMask\?\.intersects/);
});

test("streams and fades the rock layer with detailed terrain tiles", () => {
  assert.match(game, /createRockField\(this\.scene, terrainData/);
  assert.match(game, /record\.rockField = rockField/);
  assert.match(game, /rockField\.setFade\(fade\)/);
  assert.match(game, /record\.rockField\?\.root\.dispose/);
});
