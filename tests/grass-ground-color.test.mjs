import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getTerrainTextureData, terrainAverageAlbedo } from "../src/terrain/TerrainTextureData.ts";

test("grass ground target includes the actual terrain texture average", () => {
  const { albedo } = getTerrainTextureData();
  const average = terrainAverageAlbedo();
  for (let channel = 0; channel < 3; channel++) {
    let sum = 0;
    for (let offset = channel; offset < albedo.length; offset += 4) sum += albedo[offset];
    assert.ok(Math.abs(average[channel] - sum / (albedo.length / 4) / 255) < 1e-12);
    assert.ok(average[channel] > 0.5 && average[channel] < 0.9);
  }
});

const fieldSource = readFileSync(new URL("../src/vegetation/GrassField.ts", import.meta.url), "utf8");
const impostorSource = readFileSync(new URL("../src/vegetation/TreeField.ts", import.meta.url), "utf8");
const modelSource = readFileSync(
  new URL("../src/procedural/ProceduralCaptureMaterial.ts", import.meta.url),
  "utf8",
);

test("grass instances inherit their local rendered ground color", () => {
  assert.match(fieldSource, /varyGroundColor\(/);
  assert.match(fieldSource, /landCover\.sampleSurfaceColor\?\.\(lon, lat\)/);
  assert.match(fieldSource, /surfaceColor = landCoverSurfaceColor\(landCover\)/);
  assert.match(fieldSource, /const color = grassGroundColorMultiplier/);
  assert.match(fieldSource, /addProceduralVariantPlacement\([\s\S]*?matrix,[\s\S]*?color/);
});

test("WorldCover exposes a continuous tint across source raster cells", () => {
  const worldCoverSource = readFileSync(
    new URL("../src/world/WorldCover.ts", import.meta.url),
    "utf8",
  );
  assert.match(worldCoverSource, /sampleSurfaceColor\(/);
  assert.match(worldCoverSource, /pixelX[\s\S]*?- 0\.5/);
  assert.match(worldCoverSource, /tintBoundaryNoise\.sample/);
  assert.match(worldCoverSource, /wx\[column\] \* wy\[row\]/);
});

test("grass applies the tint consistently to models and impostors", () => {
  assert.match(fieldSource, /configureVegetationMaterials\(\[grass, grassModel\]/);
  assert.match(fieldSource, /instanceColorCoverage: 1/);
  assert.match(impostorSource, /max\(petalMask, instanceColorCoverage\)/);
  assert.match(modelSource, /max\(petalMask, instanceColorCoverage\)/);
  assert.match(impostorSource, /setFloat\("instanceColorCoverage", 0\)/);
  assert.match(modelSource, /setFloat\("instanceColorCoverage", 0\)/);
});

test("distant grass fades according to the active full-detail distance", () => {
  assert.match(fieldSource, /distanceFadeNear/);
  assert.match(fieldSource, /distanceFadeFar/);
  assert.match(fieldSource, /grassDistanceFadeRange\(/);
  assert.match(fieldSource, /vegetationDistanceFadeRange as grassDistanceFadeRange/);
  assert.match(fieldSource, /distanceGroundColor/);
  assert.match(
    impostorSource,
    /distanceGroundColor \* vInstanceColor,[\s\S]*?mix\(groundColorBlend, distanceGroundBlend, 1\.0 - distanceFade\)/,
  );
  // Far grass thins by shrinking and dropping whole opaque clumps in a stable
  // per-instance order. Neither translucency nor a screen-space dither is
  // involved, so nothing behind a clump ever shows through it.
  const dropoutSource = readFileSync(new URL("../src/vegetation/DistanceDropout.ts", import.meta.url), "utf8");
  assert.match(
    dropoutSource,
    /survival = 1\.0 - smoothstep\(\s*distanceFadeNear,\s*distanceFadeFar,\s*length\(cameraPosition - instanceOrigin\)/,
  );
  assert.match(dropoutSource, /distanceDropoutHash\(instanceOrigin\.xz\)/);
  assert.match(impostorSource, /distanceDropoutScale\(instanceOrigin, cameraPosition, vDistanceFade\)/);
  assert.match(impostorSource, /finalWorld\[0\]\.xyz \*= dropoutScale;/);
  assert.match(impostorSource, /gl_FragColor = vec4\([\s\S]*?, 1\.0\);/);
  assert.doesNotMatch(impostorSource, /bayer8\([\s\S]*?\) >= distanceFade\) discard/);
  assert.doesNotMatch(impostorSource, /\* distanceFade;/);
  assert.doesNotMatch(fieldSource, /needAlphaBlending = true/);
  // The live model shares the threshold so both LODs of a clump drop together.
  assert.match(modelSource, /distanceDropoutScale\(finalWorld\[3\]\.xyz, cameraPosition, dropoutSurvival\)/);
  assert.match(modelSource, /\.\.\.DISTANCE_DROPOUT_UNIFORMS/);
  assert.match(fieldSource, /configureVegetationMaterials\(\[grass, grassModel\], \{[\s\S]*?distanceFadeNear: fade\.near/);
  assert.match(modelSource, /distanceGroundColor \* vInstanceColor/);
});

test("loaded and newly committed grass fields use the current detail setting", () => {
  const game = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
  assert.match(
    game,
    /kind === "grassField" \|\| kind === "bushField" \|\| kind === "tallPlantField"[\s\S]*?setVegetationFieldDetailDistance\([\s\S]*?detailTilesAcross/,
  );
  assert.match(
    game,
    /if \(detailSizeChanged\) this\.updateVegetationDetailDistance\(\)/,
  );
  assert.match(
    game,
    /updateVegetationDetailDistance\(\)[\s\S]*?record\.grassField, record\.bushField, record\.tallPlantField[\s\S]*?setVegetationFieldDetailDistance/,
  );
});

test("grass retains the full skylight default instead of darkening its impostors", () => {
  assert.doesNotMatch(fieldSource, /impostorAmbientUpward:/);
  assert.match(impostorSource, /setFloat\("impostorAmbientUpward", 1\)/);
});
