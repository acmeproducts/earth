import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fieldSource = readFileSync(new URL("../src/GrassField.ts", import.meta.url), "utf8");
const impostorSource = readFileSync(new URL("../src/TreeField.ts", import.meta.url), "utf8");
const modelSource = readFileSync(
  new URL("../src/ProceduralCaptureMaterial.ts", import.meta.url),
  "utf8",
);

test("grass instances inherit their local rendered ground color", () => {
  assert.match(fieldSource, /varyGroundColor\(/);
  assert.match(fieldSource, /landCoverSurfaceColor\(landCover\)/);
  assert.match(fieldSource, /colors\.push\(\.\.\.grassGroundColorMultiplier/);
  assert.match(fieldSource, /new Float32Array\(colors\)/);
});

test("grass applies the tint consistently to models and impostors", () => {
  assert.match(fieldSource, /instanceColorCoverage", 1/g);
  assert.match(impostorSource, /max\(petalMask, instanceColorCoverage\)/);
  assert.match(modelSource, /max\(petalMask, instanceColorCoverage\)/);
  assert.match(impostorSource, /setFloat\("instanceColorCoverage", 0\)/);
  assert.match(modelSource, /setFloat\("instanceColorCoverage", 0\)/);
});

test("distant grass dissolves according to the active full-detail distance", () => {
  assert.match(fieldSource, /distanceFadeNear/);
  assert.match(fieldSource, /distanceFadeFar/);
  assert.match(fieldSource, /grassDistanceFadeRange\(/);
  assert.match(fieldSource, /\(size \+ 1\) \/ 2 - GRASS_FADE_EDGE_INSET_TILE_WIDTHS/);
  assert.match(fieldSource, /far - width \* GRASS_FADE_TRANSITION_TILE_WIDTHS/);
  assert.match(fieldSource, /distanceGroundColor/);
  assert.match(
    impostorSource,
    /distanceGroundColor \* vInstanceColor,[\s\S]*?mix\(groundColorBlend, distanceGroundBlend, 1\.0 - distanceFade\)/,
  );
  assert.match(impostorSource, /bayer8\([\s\S]*?\) >= distanceFade\) discard/);
  assert.match(modelSource, /distanceGroundColor \* vInstanceColor/);
});

test("loaded and newly committed grass fields use the current detail setting", () => {
  const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");
  assert.match(
    game,
    /kind === "grassField"[\s\S]*?setGrassFieldDetailDistance\([\s\S]*?detailTilesAcross/,
  );
  assert.match(
    game,
    /if \(detailSizeChanged\) this\.updateGrassDetailDistance\(\)/,
  );
  assert.match(
    game,
    /updateGrassDetailDistance\(\)[\s\S]*?record\.grassField[\s\S]*?setGrassFieldDetailDistance/,
  );
});

test("grass uses ground-aware ambient light and terrain-matched shadows", () => {
  assert.match(fieldSource, /GRASS_SHADOW_DARKNESS = 0;/);
  assert.match(fieldSource, /impostorAmbientUpward", GRASS_AMBIENT_UPWARD/);
  assert.match(fieldSource, /vegetationShadowDarkness", GRASS_SHADOW_DARKNESS/g);
  assert.match(impostorSource, /mix\(groundColor, skyColor, impostorAmbientUpward\)/);
});
