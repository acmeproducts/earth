import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const proceduralTrees = readFileSync(
  new URL("../src/ProceduralTree.ts", import.meta.url),
  "utf8",
);
const treeField = readFileSync(new URL("../src/TreeField.ts", import.meta.url), "utf8");

test("defines an abstract procedural tree family with birch, pine, and spruce", () => {
  assert.match(proceduralTrees, /export abstract class ProceduralTree/);
  assert.match(proceduralTrees, /export class BirchTree extends ProceduralTree/);
  assert.match(proceduralTrees, /export class PineTree extends ProceduralTree/);
  assert.match(proceduralTrees, /export class SpruceTree extends ProceduralTree/);
});

test("clusters forest species with simplex noise", () => {
  assert.match(treeField, /\["birch", "pine", "spruce"\]/);
  assert.match(treeField, /new SimplexNoise2D/);
  assert.match(treeField, /sampleTreeSpecies/);
  assert.doesNotMatch(treeField, /speciesList\[matrices\.length % speciesList\.length\]/);
});

test("captures species sequentially so the gameplay camera is restored", () => {
  assert.match(treeField, /for \(const species of speciesList\)/);
  assert.doesNotMatch(treeField, /Promise\.all\(speciesList\.map/);
});

test("broadens pine branching and converges species brightness in low light", () => {
  assert.match(proceduralTrees, /firstLevel = species === "pine" \? 5 : 2/);
  assert.match(proceduralTrees, /const sprays = species === "pine" \? 5 : 6/);
  assert.match(proceduralTrees, /TREE_LOW_LIGHT_BRIGHTNESS/);
  assert.match(treeField, /lowLightAlbedoScale/);
});

test("scales pine up and spruce down", () => {
  assert.match(treeField, /pine: 1\.16/);
  assert.match(treeField, /spruce: 0\.86/);
  assert.match(treeField, /\* speciesScale/);
});
