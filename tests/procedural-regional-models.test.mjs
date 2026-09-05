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

test("cooperative captures yield between GPU views and pixel-processing slices", () => {
  const impostors = source("Impostor.ts");
  assert.match(impostors, /RUNTIME_CAPTURE_FRAME_BUDGET_MS = 2/);
  assert.match(impostors, /cooperative && viewsThisFrame >= viewsPerSlice/);
  assert.match(impostors, /await binaryImage/);
  assert.match(impostors, /await dilateTransparentTileEdgeColors/);
  assert.match(impostors, /yieldCaptureWorkIfNeeded/);
});

test("startup and streamed requests share the same atlas sampling", () => {
  const impostors = source("Impostor.ts");
  assert.match(
    impostors,
    /const regionalVariant = variant\.key !== DEFAULT_IMPOSTOR_VARIANT\.key;[\s\S]*?const cooperative = requestOptions\.cooperative \?\? regionalVariant;[\s\S]*?const sampling = requestedSampling;/,
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
  const trees = source("procedural/ProceduralTree.ts");
  assert.match(trees, /function applyRegionalTreeCharacter/);
  assert.match(trees, /const widthScale = 0\.76 \+ random\(\) \* 0\.48/);
  assert.match(trees, /const depthScale = 0\.76 \+ random\(\) \* 0\.48/);
  assert.match(trees, /const crownLeanDistance = random\(\) \* 0\.18/);
  assert.match(trees, /smoothstep01\(\(height01 - 0\.45\) \/ 0\.55\)/);
  assert.match(trees, /crownLeanX \* crown/);
  assert.match(trees, /foliageGreen/);
  assert.match(trees, /textureU < 0 \|\| textureU >= 1\.5/);
});

test("tree sister variants use a tile-anchored, traversal-scale locality", () => {
  const field = source("TreeField.ts");
  const selection = field.match(
    /proceduralLocalVariantAtLocation\([\s\S]*?TREE_SISTER_MODELS,([\s\S]*?)\);/,
  );
  assert.ok(selection, "tree sister variant selection is present");
  assert.match(selection[1], /TREE_VARIANT_SPAN_TILES,[\s\S]*?0/);
  assert.match(field, /const TREE_VARIANT_SPAN_TILES = 256/);
  assert.match(field, /const tileVariantLocation = sceneToLonLat/);
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
  assert.match(field, /const stand = habitat\.sample\(lon, lat\)/);
  assert.match(field, /const BUSH_SISTER_MODELS = 3/);
  assert.match(field, /^\s+BUSH_SISTER_MODELS,$/m);
  assert.match(bushes, /const growthHabit = random\(\)/);
  assert.match(bushes, /const leafScale = 0\.72 \+ random\(\) \* 0\.66/);
  assert.match(bushes, /const sprayCount = Math\.round\(258 \/ leafScale\)/);
  assert.match(bushes, /ACCENT_PALETTES/);
  assert.match(bushes, /function addAccent/);
});
