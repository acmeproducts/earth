import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("./ts-extension-resolver.mjs", import.meta.url);
const {
  sampleWorldTreeSpecies,
  treeDistributionAt,
} = await import("../src/TreeDistribution.ts");

test("returns normalized ratios for representative forest regions", () => {
  for (const [lon, lat] of [[-63, -4], [25, 0], [105, 10], [10, 50], [25, 65]]) {
    const result = treeDistributionAt(lon, lat);
    const total = result.trees.reduce((sum, tree) => sum + tree.ratio, 0);
    const biomeTotal = result.biomes.reduce((sum, biome) => sum + biome.ratio, 0);
    assert.ok(Math.abs(total - 1) < 1e-12);
    assert.ok(Math.abs(biomeTotal - 1) < 1e-12);
    assert.ok(result.trees.every((tree) => tree.ratio > 0 && tree.ratio <= 1));
  }
});

test("recognizes broad regional character", () => {
  assert.equal(treeDistributionAt(-63, -4).biome, "tropical-rainforest");
  assert.equal(treeDistributionAt(14, 60).biome, "boreal-forest");
  assert.equal(treeDistributionAt(15, 25).biome, "desert");
  const australianTrees = treeDistributionAt(151, -32).trees;
  const dominantAustralianTree = australianTrees.reduce((a, b) => a.ratio > b.ratio ? a : b);
  assert.equal(dominantAustralianTree.species, "eucalyptus");
  assert.equal(treeDistributionAt(0, 80).trees.length, 0);
});

test("smoothly blends across former latitude and regional boundaries", () => {
  const boundaries = [
    { lon: 0, lat: 12, axis: "lat" },
    { lon: 0, lat: 27, axis: "lat" },
    { lon: 0, lat: 55, axis: "lat" },
    { lon: 0, lat: 72, axis: "lat" },
    { lon: -17, lat: 25, axis: "lon" },
    { lon: -63, lat: 8, axis: "lat" },
    { lon: -12, lat: 38, axis: "lon" },
    { lon: 116, lat: -25, axis: "lon" },
  ];
  const epsilon = 0.001;
  for (const boundary of boundaries) {
    const west = treeDistributionAt(
      boundary.lon - (boundary.axis === "lon" ? epsilon : 0),
      boundary.lat - (boundary.axis === "lat" ? epsilon : 0),
    );
    const east = treeDistributionAt(
      boundary.lon + (boundary.axis === "lon" ? epsilon : 0),
      boundary.lat + (boundary.axis === "lat" ? epsilon : 0),
    );
    assert.ok(distributionDistance(west, east) < 0.002);
    assert.ok(Math.abs(west.treeCoverPotential - east.treeCoverPotential) < 0.002);
  }
});

test("samples species from the returned ratios", () => {
  const result = treeDistributionAt(10, 50);
  assert.equal(sampleWorldTreeSpecies(result, 0), result.trees[0].species);
  assert.equal(sampleWorldTreeSpecies(result, 0.999999), result.trees.at(-1).species);
});

test("rejects invalid coordinates and random values", () => {
  assert.throws(() => treeDistributionAt(181, 0), RangeError);
  assert.throws(() => treeDistributionAt(0, -91), RangeError);
  assert.throws(() => sampleWorldTreeSpecies(treeDistributionAt(0, 0), 1), RangeError);
});

function distributionDistance(a, b) {
  const ratios = (distribution) => new Map(distribution.trees.map((tree) => [tree.species, tree.ratio]));
  const left = ratios(a);
  const right = ratios(b);
  const species = new Set([...left.keys(), ...right.keys()]);
  return [...species].reduce((sum, name) => sum + Math.abs((left.get(name) ?? 0) - (right.get(name) ?? 0)), 0);
}
