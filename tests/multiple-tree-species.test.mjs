import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const proceduralTrees = readFileSync(
  new URL("../src/ProceduralTree.ts", import.meta.url),
  "utf8",
);
const treeField = readFileSync(new URL("../src/TreeField.ts", import.meta.url), "utf8");
const impostorCapture = readFileSync(new URL("../src/Impostor.ts", import.meta.url), "utf8");
const captureMaterial = readFileSync(
  new URL("../src/ProceduralCaptureMaterial.ts", import.meta.url),
  "utf8",
);

test("defines procedural generators for every geographic tree group", () => {
  assert.match(proceduralTrees, /export abstract class ProceduralTree/);
  assert.match(proceduralTrees, /export class BirchTree extends ProceduralTree/);
  assert.match(proceduralTrees, /export class PineTree extends ProceduralTree/);
  assert.match(proceduralTrees, /export class SpruceTree extends ProceduralTree/);
  for (const species of ["Acacia", "Beech", "Eucalyptus", "Fir", "Mangrove", "Maple", "Oak", "Palm"]) {
    assert.match(proceduralTrees, new RegExp(`export class ${species}Tree`));
  }
});

test("clusters forest species with simplex noise", () => {
  assert.match(treeField, /TREE_SPECIES_LIST/);
  assert.match(treeField, /new SimplexNoise2D/);
  assert.match(treeField, /sampleTreeSpecies/);
  assert.match(treeField, /treeDistributionAt/);
  assert.match(treeField, /sampleWorldTreeSpecies/);
  assert.doesNotMatch(treeField, /speciesList\[matrices\.length % speciesList\.length\]/);
});

test("captures resources only after discovering species in the tile", () => {
  const discovery = treeField.indexOf("TREE_SPECIES_LIST.filter((species) => speciesMatrices[species].length > 0)");
  const capture = treeField.indexOf("for (const species of speciesList)");
  assert.ok(discovery >= 0);
  assert.ok(capture > discovery);
  assert.doesNotMatch(treeField, /const speciesList: TreeSpecies\[\] =/);
});

test("captures species sequentially so the gameplay camera is restored", () => {
  assert.match(treeField, /for \(const species of speciesList\)/);
  assert.doesNotMatch(treeField, /Promise\.all\(speciesList\.map/);
});

test("keeps lazy capture sources and cameras out of gameplay frames", () => {
  assert.match(impostorCapture, /mesh\.isVisible = false/);
  assert.match(impostorCapture, /target\.activeCamera = camera/);
  assert.doesNotMatch(impostorCapture, /scene\.activeCamera = camera/);
});

test("applies transparent foliage only to leaf UVs", () => {
  assert.match(captureMaterial, /if \(vUv\.x >= 1\.5\)/);
  assert.match(captureMaterial, /else if \(leafTextureEnabled > 0\.5 && vUv\.x >= 0\.0\)/);
});

test("uses optional species textures with procedural-color fallback", () => {
  assert.match(proceduralTrees, /require as NodeRequire/);
  assert.match(proceduralTrees, /availableFoliageTextures\.has\(path\)/);
  assert.match(proceduralTrees, /Partial<Record<TreeSpecies, string>>/);
  assert.match(captureMaterial, /setFloat\("leafTextureEnabled", 0\)/);
  assert.match(captureMaterial, /setFloat\("leafTextureEnabled", 1\)/);
});

test("gives every tree species its own procedural bark texture", () => {
  assert.match(captureMaterial, /export function getTreeBarkTexture/);
  assert.match(captureMaterial, /Record<TreeBarkStyle, number>/);
  assert.match(captureMaterial, /species === "eucalyptus"/);
  assert.match(captureMaterial, /species === "palm"/);
  assert.match(captureMaterial, /species === "oak" \|\| species === "mangrove"/);
  assert.match(proceduralTrees, /getTreeBarkTexture\(scene, species\)/);
});

test("gives pine an open, twigged crown and converges species brightness in low light", () => {
  assert.match(proceduralTrees, /firstLevel = species === "pine" \? 5 : 2/);
  assert.match(proceduralTrees, /const branches = species === "pine" \? 4 \+ \(level % 3 === 0 \? 1 : 0\) : 6/);
  assert.match(proceduralTrees, /const branchletCount = species === "pine" \? 3 : 1/);
  assert.match(proceduralTrees, /function addPineNeedleTuft/);
  assert.match(proceduralTrees, /TREE_LOW_LIGHT_BRIGHTNESS/);
  assert.match(treeField, /lowLightAlbedoScale/);
});

test("scales pine up and spruce down", () => {
  assert.match(treeField, /pine: 1\.16/);
  assert.match(treeField, /spruce: 0\.86/);
  assert.match(treeField, /\* speciesScale/);
});
