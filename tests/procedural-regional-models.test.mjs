import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

test("every vegetation family assigns placements to its own regional variants", () => {
  for (const [file, family] of [
    ["TreeField.ts", "trees"],
    ["BushField.ts", "bushes"],
    ["GrassField.ts", "grass"],
    ["FernField.ts", "ferns"],
    ["TallPlantField.ts", "tallPlants"],
  ]) {
    const field = source(file);
    assert.match(field, new RegExp(`"${family}"`));
    assert.match(field, /modelVariantSeed/);
    assert.match(field, /variant\.seed/);
  }
});

test("regional impostor captures are leased, bounded, and serialized", () => {
  const impostors = source("Impostor.ts");
  assert.match(impostors, /variant\.key/);
  assert.match(impostors, /variant\.seed \?\? "static"/);
  assert.match(impostors, /MAX_CACHED_IMPOSTOR_VARIANTS = 6/);
  assert.match(impostors, /references === 0 && !entry\.pinned/);
  assert.match(impostors, /enqueueImpostorCapture/);
});

test("runtime captures yield between GPU views and pixel-processing slices", () => {
  const impostors = source("Impostor.ts");
  assert.match(impostors, /RUNTIME_CAPTURE_FRAME_BUDGET_MS = 2/);
  assert.match(impostors, /RUNTIME_CAPTURE_MAX_DIRECTION_SAMPLES = 4/);
  assert.match(impostors, /RUNTIME_CAPTURE_MAX_RESOLUTION = 128/);
  assert.match(impostors, /runtimeCaptureSampling\(requestedSampling\)/);
  assert.match(impostors, /cooperative && viewsThisFrame >= 1/);
  assert.match(impostors, /await binaryImage/);
  assert.match(impostors, /await dilateTransparentTileEdgeColors/);
  assert.match(impostors, /yieldCaptureWorkIfNeeded/);
});

test("startup and streamed requests share the same regional atlas cache key", () => {
  const impostors = source("Impostor.ts");
  assert.match(
    impostors,
    /const regionalVariant = variant\.key !== DEFAULT_IMPOSTOR_VARIANT\.key;[\s\S]*?const cooperative = requestOptions\.cooperative \?\? regionalVariant;[\s\S]*?const sampling = regionalVariant[\s\S]*?runtimeCaptureSampling\(requestedSampling\)/,
  );
  assert.doesNotMatch(
    impostors,
    /const sampling = cooperative\s*\?[\s\S]*?runtimeCaptureSampling\(requestedSampling\)/,
  );
});

test("initial tree atlases use the fast path while streamed atlases remain cooperative", () => {
  const game = source("Game.ts");
  const trees = source("TreeField.ts");
  const impostors = source("Impostor.ts");
  assert.match(game, /impostorCaptureMode: onProgress \? "fast"[^\n]+: "cooperative"/);
  assert.match(trees, /impostorCaptureMode === "cooperative"/);
  assert.match(impostors, /cooperativeOverride \?\? variant\.key !== DEFAULT_IMPOSTOR_VARIANT\.key/);
});

test("streamed detail and far trees share one world-level model seed", () => {
  const game = source("Game.ts");
  const matches = game.match(/modelVariantSeed: layerSeed\(this\.worldSeed, "proceduralModels"\)/g);
  assert.ok(matches && matches.length >= 2);
});

test("tree sister variants alter macro silhouette and foliage character", () => {
  const trees = source("ProceduralTree.ts");
  assert.match(trees, /function applyRegionalTreeCharacter/);
  assert.match(trees, /const widthScale = 0\.76 \+ random\(\) \* 0\.48/);
  assert.match(trees, /const depthScale = 0\.76 \+ random\(\) \* 0\.48/);
  assert.match(trees, /const crownLeanDistance = random\(\) \* 0\.18/);
  assert.match(trees, /smoothstep01\(\(height01 - 0\.45\) \/ 0\.55\)/);
  assert.match(trees, /crownLeanX \* crown/);
  assert.match(trees, /foliageGreen/);
  assert.match(trees, /textureU < 0 \|\| textureU >= 1\.5/);
});

test("bush variants and placements avoid repeated radial silhouettes", () => {
  const bushes = source("BushImpostor.ts");
  const field = source("BushField.ts");

  assert.match(bushes, /const crownRotation = random\(\)/);
  assert.match(bushes, /const lobePhase = random\(\)/);
  assert.match(bushes, /const paletteCenter = Math\.floor\(random\(\)/);
  assert.match(bushes, /const localBottom/);
  assert.match(bushes, /function addLeaf/);
  assert.match(bushes, /for \(const along of \[0\.34, 0\.66\]\)/);
  assert.match(bushes, /Math\.pow\(Math\.sin\(Math\.PI \* t\), 0\.72\)/);
  assert.doesNotMatch(bushes, /bladeAngle|shootCount/);
  assert.match(field, /const widthScaleX/);
  assert.match(field, /const widthScaleZ/);
  assert.match(field, /new Vector3\(widthScaleX, heightScale, widthScaleZ\)/);
});
