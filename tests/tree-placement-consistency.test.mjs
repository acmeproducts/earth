import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { Matrix, Vector3 } from "@babylonjs/core";
import { cellRandom, createSeededRandom, deriveSeed } from "../src/core/Random.ts";

const source = readFileSync(new URL("../src/vegetation/TreeField.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("TreeField.ts", source, ts.ScriptTarget.Latest, true);
let placementLoop;
function visit(node) {
  if (!placementLoop && ts.isForStatement(node) &&
      node.initializer?.getText(ast).includes("row = 0") &&
      node.getText(ast).includes("matrices.push(matrix)")) placementLoop = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(placementLoop, "exercise the actual standing-tree and log placement loop");

async function place(includeFallenLogs, exclude = () => false) {
  const scope = {
    Matrix, Vector3, cellRandom, createSeededRandom, deriveSeed,
    seed: 314159, random: createSeededRandom(314159),
    rows: 20, columns: 20, meshWidth: 70, meshDepth: 70, cellWidth: 3.5, cellDepth: 3.5,
    forestMask: new Uint8Array(400).fill(1), edgeDistances: new Float32Array(400).fill(100),
    elevationSampler: () => 10, terrain: { bounds: {} },
    exclusionMask: { intersects: exclude }, maximumHalfWidth: 1, waterLineMeters: 0,
    isTerrainFootprintAbove: () => true, fullDensityDepthMeters: 45,
    positionOffset: Vector3.Zero(), metersPerUnit: 1, occupancy: 0.52, edgeOccupancy: 0.12,
    sceneToLonLat: (x, z) => ({lon: x, lat: z}), treeDistributionAt: () => ({biomes: []}),
    RAINFOREST_OCCUPANCY_BOOST: 0.55, RAINFOREST_HEIGHT_BOOST: 0.3, densityScale: undefined,
    groundMetersAt: (x, y) => ({x, y}), speciesNoise: {}, speciesDetailNoise: {},
    sampleTreeSpecies: (_a, _b, _x, _y, _d, value) => value < 0.5 ? "pine" : "birch",
    TREE_SPECIES_SCALE: {pine: 1.16, birch: 1}, matrices: [], trunks: {add() {}}, treeHeight: 11,
    TREE_TRUNK_PROFILES: {pine: {radius: 0.1, heightFraction: 0.8}, birch: {radius: 0.1, heightFraction: 0.8}},
    TREE_SPECIES: {pine: {sourceHeight: 3}, birch: {sourceHeight: 3}},
    modelVariantSeed: 123, seasonalDate: undefined, tileVariantLocation: {lat: 60},
    treeSeasonAt: () => ({key: "summer"}), tileRegion: {key: "region", seed: 789},
    tileLocalVariant: 1, layerSeed: deriveSeed, variantBuckets: new Map(),
    snowCover: 0, snowCoveredVariant: (variant) => variant,
    includeFallenLogs, FALLEN_LOG_MINIMUM_INTERIOR_DEPTH: 0.7, FALLEN_LOG_CHANCE: 0.25,
    yieldControl: undefined,
  };
  const code = ts.transpileModule(`async function run() { ${placementLoop} }`, {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  }).outputText;
  await new Function(...Object.keys(scope), `${code}; return run();`)(...Object.values(scope));
  return {
    trees: [...scope.variantBuckets].flatMap(([key, bucket]) => bucket.matrices.map(matrix => (
      {key, matrix: Array.from(matrix.m)}
    ))).sort((a, b) => a.matrix[12] - b.matrix[12] || a.matrix[14] - b.matrix[14]),
    logs: [...scope.variantBuckets.values()].reduce((sum, bucket) => sum + bucket.fallenLogMatrices.length, 0),
  };
}

test("detail-only fallen logs preserve every standing-tree transform and variant", async () => {
  const distant = await place(false);
  const detailed = await place(true);
  assert.ok(distant.trees.length > 100);
  assert.ok(detailed.logs > 0);
  assert.deepEqual(detailed.trees, distant.trees);
});

test("excluding an area does not move or change the remaining trees", async () => {
  const full = await place(true);
  const excluded = await place(true, x => x < 0);
  assert.deepEqual(excluded.trees, full.trees.filter(tree => tree.matrix[12] >= 0));
});

test("distant trees use the detailed placement defaults and boundary exclusions", () => {
  const game = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
  const far = game.slice(game.indexOf("private async buildFarTrees"), game.indexOf("private async buildFarBuildings"));
  assert.doesNotMatch(far, /\b(?:spacingMeters|occupancy|edgeOccupancy)\s*:/);
  assert.match(far, /OpenStreetMapBarriers\.createPlannedExclusionMask/);
  assert.match(far, /TerrainSurface\.fromGroundMesh/);
});
