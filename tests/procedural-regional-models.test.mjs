import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

test("every vegetation family assigns placements to its own regional variants", () => {
  for (const [file, family] of [
    ["TreeField.ts", "trees"],
    ["BushField.ts", "bushes"],
    ["GrassField.ts", "grass"],
    ["FlowerField.ts", "flowers"],
    ["FernField.ts", "ferns"],
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
  assert.match(impostors, /cooperative && viewsThisFrame >= 1/);
  assert.match(impostors, /await binaryImage/);
  assert.match(impostors, /await dilateTransparentTileEdgeColors/);
  assert.match(impostors, /yieldCaptureWorkIfNeeded/);
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
