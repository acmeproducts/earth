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

test("fern undergrowth shares one directional source between its model and impostor", () => {
  const capture = source("FernImpostor.ts");
  const field = source("FernField.ts");

  assert.match(capture, /faces: IMPOSTOR_CUBE_FACES/);
  assert.match(capture, /rotationallySymmetric: false/);
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
  assert.match(field, /const FERN_CLUSTER_MIN_COUNT = 3/);
  assert.match(field, /const FERN_CLUSTER_MAX_COUNT = 5/);
  assert.match(field, /addFern\(x, z, 1\)/);
});

test("fern patches use the supplied foliage image on curved fronds", () => {
  const capture = source("FernImpostor.ts");
  const field = source("FernField.ts");

  assert.match(capture, /assets\/vegetation\/fern\/foliage\.png/);
  assert.match(capture, /data\.uvs = uvs/);
  assert.match(capture, /FERN_FOLIAGE_TEXTURE_URL/);
  assert.match(capture, /const FROND_SEGMENTS = 8/);
  assert.match(capture, /const FROND_COUNT = 18/);
  assert.match(capture, /positionAlongRhizome/);
  assert.doesNotMatch(capture, /baseRadius|ROTATIONAL_SYMMETRY_ORDER/);
  assert.match(field, /const FERN_CLUSTER_RADIUS_METERS = 1\.8/);
  assert.match(field, /for \(let member = 1; member < clusterCount; member\+\+\)/);
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

test("mature detailed forests include sparse species-matched fallen logs", () => {
  const trees = source("TreeField.ts");
  const proceduralTrees = source("ProceduralTree.ts");
  const treeImpostors = source("TreeImpostor.ts");

  assert.match(proceduralTrees, /interface ProceduralTreeParts \{[\s\S]*?log: Mesh;[\s\S]*?branches: Mesh;/);
  assert.match(treeImpostors, /return \[parts\.log, parts\.branches\]/);
  assert.match(treeImpostors, /export async function createTreeLogModel/);
  assert.match(trees, /depth >= FALLEN_LOG_MINIMUM_INTERIOR_DEPTH/);
  assert.match(trees, /random\(\) < FALLEN_LOG_CHANCE/);
  assert.match(trees, /createTreeLogModel\(scene, treeHeight, species, variant\.seed\)/);
  assert.match(trees, /createVegetationFieldResult\([\s\S]*?\[\],[\s\S]*?\[fallenLogModel\],[\s\S]*?"auto"/);
  assert.match(game, /includeFallenLogs: true/);

  const farStart = game.indexOf("private async buildFarTrees");
  const farSource = game.slice(farStart, game.indexOf("private async buildFarBuildings", farStart));
  assert.doesNotMatch(farSource, /includeFallenLogs/);
});
