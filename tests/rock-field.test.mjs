import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/vegetation/RockField.ts", import.meta.url), "utf8");
const game = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
const streamedTile = readFileSync(new URL("../src/world/StreamedTile.ts", import.meta.url), "utf8");

test("builds deterministic bare and mossy thin-instanced rock variants", () => {
  assert.match(source, /createSeededRandom\(seed\)/);
  assert.match(source, /ROCK_VARIANTS \* 2/);
  assert.match(source, /mossy \? "mossy" : "bare"/);
  assert.match(source, /thinInstanceSetBuffer/);
  assert.match(source, /VertexBuffer\.ColorKind/);
  assert.match(source, /subdivisions: angular \? 4 : 2, flat: angular/);
  assert.match(source, /VertexData\.ComputeNormals\(positions, indices, normals\)/);
  // updateVerticesData is a no-op on the builder's non-updatable buffers.
  assert.match(source, /rock\.setVerticesData\(VertexBuffer\.NormalKind, normals\)/);
  assert.doesNotMatch(source, /updateVerticesData/);
});

test("mixes in blocky fractured stones and a rare tail of large boulders", () => {
  assert.match(source, /const ROCK_VARIANTS = 5/);
  assert.match(source, /const ROUNDED_VARIANTS = 3/);
  assert.match(source, /const angular = variant >= ROUNDED_VARIANTS/);
  assert.match(source, /angular \? clipToFracturePlanes\(positions, random\) : \[\]/);
  assert.match(source, /^\s+smoothNormalsOffFacets\(positions, indices, normals, facets\);/m);
  assert.match(source, /random\(\) < ANGULAR_CHANCE/);
  assert.match(source, /random\(\) < BOULDER_CHANCE\s*\?\s*2\.2 \+/);
  assert.match(source, /random\(\) < SHORE_BOULDER_CHANCE\s*\?\s*1\.6 \+/);
  assert.equal((source.match(/^\s+\[0\.\d+, 0\.\d+, 0\.\d+\],$/gm) ?? []).length >= 5, true);
});

test("shades rocks with encoded normal maps rather than raw noise", () => {
  // A NoiseProceduralTexture in a bump slot decodes to normals that lean and
  // flip into the surface wherever the texel is darker than mid-grey.
  assert.doesNotMatch(source, /NoiseProceduralTexture/);
  assert.match(source, /getRockTextureData\(\)/);
  assert.match(source, /material\.bumpTexture = relief/);
  assert.match(source, /material\.detailMap\.texture = createRockTexture\(/);
  assert.match(source, /gammaSpace = false/);
});

test("shore rocks form long dense chains aligned to the water boundary", () => {
  assert.match(source, /function shorelineDirection/);
  assert.match(source, /tangentX: -waterZ \/ length/);
  assert.match(source, /lengthMeters = 12 \+ random\(\) \* 18/);
  assert.match(source, /count = Math\.max\(6, Math\.round\(lengthMeters \/ spacingMeters\)\)/);
  assert.match(source, /shoreHabitat = habitatField\("rockShores", modelVariantSeed/);
  assert.match(source, /const formation = shoreHabitat\.sample\(lon, lat\)/);
  assert.match(source, /do not mix in the even inland scatter/);
});

test("keeps the general grassland rock scatter sparse", () => {
  assert.match(source, /\[LandCoverClass\.Grassland\]: 0\.015/);
  assert.match(source, /const habitat = habitatField\("rocks", modelVariantSeed, HABITAT\)/);
  assert.match(source, /const stand = habitat\.sample\(lon, lat\)/);
  assert.doesNotMatch(source, /STONY_FLOOR/);
  assert.match(source, /if \(stand <= 0\) continue/);
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
  assert.match(streamedTile, /record\.rockField\?\.root\.dispose/);
});
