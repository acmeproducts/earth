import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const game = source("Game.ts");

test("saplings reuse tree species assets at a smaller rendered height", () => {
  const saplings = source("SaplingField.ts");
  const trees = source("TreeField.ts");

  assert.match(saplings, /createTreeField\(scene, terrain/);
  assert.match(saplings, /const SAPLING_HEIGHT_METERS = 3\.5/);
  assert.match(saplings, /rootName: "saplingField"/);
  assert.match(trees, /renderHeightMeters = 11/);
  assert.match(trees, /const treeHeight = renderHeightMeters \/ metersPerUnit/);
});

test("fern undergrowth shares one source between its model and upper-hemisphere impostor", () => {
  const capture = source("FernImpostor.ts");
  const field = source("FernField.ts");

  assert.match(capture, /rotationallySymmetric: true/);
  assert.match(capture, /upperHemisphereOnly: true/);
  assert.match(capture, /export function createFernModel/);
  assert.match(field, /\[fern\],\s*\[fernModel\],\s*await packInstanceMatrices/);
  assert.match(field, /renderMode = "auto"/);
});

test("undergrowth is restricted to plausible WorldCover classes", () => {
  const field = source("FernField.ts");

  for (const cover of ["TreeCover", "Shrubland", "Wetland", "Mangrove"]) {
    assert.match(field, new RegExp(`LandCoverClass\\.${cover}`));
  }
  assert.doesNotMatch(field, /LandCoverClass\.(Grassland|Cropland|SnowAndIce|BuiltUp)/);
  assert.match(field, /TreeCover\]: 0\.24/);
  assert.match(field, /Shrubland\]: 0\.035/);
  assert.match(field, /const FERN_SPACING_METERS = 3\.8/);
});

test("saplings and ferns belong to the detailed tile lifecycle only", () => {
  const detailStart = game.indexOf("private async buildTileDetail");
  const farStart = game.indexOf("private async buildFarTrees");
  const detailSource = game.slice(detailStart, farStart);
  const farSource = game.slice(farStart, game.indexOf("private async buildFarBuildings", farStart));

  assert.match(detailSource, /createSaplingField/);
  assert.match(detailSource, /createFernField/);
  assert.doesNotMatch(farSource, /createSaplingField|createFernField/);
  assert.match(game, /"saplingField"[\s\S]*?"fernField"/);
});
