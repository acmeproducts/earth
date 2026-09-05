import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const proceduralTrees = readFileSync(
  new URL("../src/procedural/ProceduralTree.ts", import.meta.url),
  "utf8",
);
const treeField = readFileSync(new URL("../src/TreeField.ts", import.meta.url), "utf8");
const impostorCapture = readFileSync(new URL("../src/Impostor.ts", import.meta.url), "utf8");
const captureMaterial = readFileSync(
  new URL("../src/procedural/ProceduralCaptureMaterial.ts", import.meta.url),
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
  const discovery = treeField.indexOf("variantBuckets.set(bucketKey, bucket)");
  const capture = treeField.indexOf("for (const bucket of variantBuckets.values())");
  assert.ok(discovery >= 0);
  assert.ok(capture > discovery);
  assert.match(treeField, /bucketKey = `\$\{species\}:\$\{variant\.key\}`/);
});

test("ignores insignificant regional tails and caps each local species palette", () => {
  assert.match(treeField, /MIN_TREE_VARIANT_SHARE = 0\.08/);
  assert.match(treeField, /MAX_TREE_SPECIES_PER_VARIANT = 3/);
  assert.match(treeField, /variantBuckets = consolidateTreeVariantBuckets\(variantBuckets\)/);
  assert.match(treeField, /value\.count \/ total >= MIN_TREE_VARIANT_SHARE/);
  assert.match(treeField, /group\.slice\(0, MAX_TREE_SPECIES_PER_VARIANT\)/);
});

test("captures species sequentially so the gameplay camera is restored", () => {
  assert.match(treeField, /for \(const bucket of variantBuckets\.values\(\)\)/);
  assert.doesNotMatch(treeField, /Promise\.all\(\[\.\.\.variantBuckets/);
});

test("uses the same regional seed for each tree model and impostor", () => {
  assert.match(treeField, /proceduralVariantAtLocation\([\s\S]*?"trees"/);
  assert.match(treeField, /createTreeImpostorPrototype\([\s\S]*?variant/);
  assert.match(
    treeField,
    /createTreeModels\(scene, treeHeight, species, variant\.seed, variant\.season\)/,
  );
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

test("keeps foliage illumination stable while the camera orbits a tree", () => {
  assert.match(captureMaterial, /float foliageMask = step\(0\.0, vUv\.x\)/);
  assert.match(captureMaterial, /mix\(0\.58, 1\.0, foliageMask\)/);
  assert.match(treeField, /mix\(groundColor, skyColor, impostorAmbientUpward\)/);
  assert.match(treeField, /dot\(vLocalWorldUp, vLocalSunDirection\)/);
  assert.doesNotMatch(treeField, /dot\(localNormal, vLocalSunDirection\)/);
});

test("uses optional species textures with procedural-color fallback", () => {
  assert.match(proceduralTrees, /require as NodeRequire/);
  assert.match(proceduralTrees, /availableFoliageTextures\.has\(path\)/);
  assert.match(proceduralTrees, /Partial<Record<TreeSpecies, string>>/);
  assert.match(captureMaterial, /setFloat\("leafTextureEnabled", 0\)/);
  assert.match(captureMaterial, /setFloat\("leafTextureEnabled", 1\)/);
});

test("keeps birch foliage in a subdued green palette", () => {
  assert.match(proceduralTrees, /const BIRCH_LEAF_TINTS = \[/);
  assert.match(proceduralTrees, /new Color3\(0\.76, 0\.86, 0\.68\)/);
  assert.match(proceduralTrees, /new Color3\(0\.84, 0\.91, 0\.75\)/);
  assert.match(proceduralTrees, /new Color3\(0\.67, 0\.8, 0\.57\)/);
});

test("waits for foliage textures before capturing any impostor angle", () => {
  assert.match(captureMaterial, /export async function waitForVertexColorTextures/);
  assert.match(captureMaterial, /textureReadiness\.set\(material, ready\)/);
  assert.match(captureMaterial, /resolveTextureReadiness\?\.\(\)/g);
  const textureWait = impostorCapture.indexOf("await waitForVertexColorTextures(meshes)");
  const atlasCapture = impostorCapture.indexOf("await captureImpostorAtlases(scene");
  assert.ok(textureWait >= 0);
  assert.ok(atlasCapture > textureWait);
});

test("gives every tree species its own procedural bark texture", () => {
  assert.match(captureMaterial, /export function getTreeBarkTexture/);
  assert.match(captureMaterial, /Record<TreeBarkStyle, number>/);
  for (const species of [
    "acacia", "beech", "birch", "eucalyptus", "fir", "mangrove",
    "maple", "oak", "palm", "pine", "spruce",
  ]) {
    if (species === "acacia") continue;
    assert.match(captureMaterial, new RegExp(`species === "${species}"`));
  }
  assert.match(captureMaterial, /const barkChip =/);
  assert.match(captureMaterial, /const strokeVertical =/);
  assert.match(captureMaterial, /Acacia: interlocking dry plates/);
  assert.match(proceduralTrees, /getTreeBarkTexture\(scene, species\)/);
});

test("keeps acacia foliage dense and eucalyptus bark subdued", () => {
  assert.match(proceduralTrees, /acacia:[\s\S]*?foliageCards: 1500/);
  assert.match(proceduralTrees, /eucalyptus:[\s\S]*?bark: new Color3\(0\.42, 0\.36, 0\.27\)/);
  assert.match(captureMaterial, /eucalyptus: \[174, 158, 128\]/);
});

test("builds palms as layered fronds with texture-shaped leaflets", () => {
  assert.match(proceduralTrees, /const palmLeafAspect = foliageCardShape\("palm"\)\?\.aspect/);
  assert.match(proceduralTrees, /const livingFrondCount = 17/);
  assert.match(proceduralTrees, /const crownLayer = frond % 4/);
  assert.match(proceduralTrees, /const halfWidth = halfLength \* palmLeafAspect/);
  assert.match(proceduralTrees, /rollCenter: Math\.PI \/ 2/);
});

test("gives pine and spruce dense, twigged crowns and converges species brightness in low light", () => {
  assert.match(proceduralTrees, /firstLevel = species === "pine" \? 3 \+ Math\.floor\(random\(\) \* 2\) : 2/);
  assert.match(proceduralTrees, /species === "spruce"\s*\? 7/);
  assert.match(proceduralTrees, /const sprays = species === "pine" \? 7/);
  assert.match(proceduralTrees, /const branchletCount = species === "pine" \? 7 : species === "spruce" \? 3 : 1/);
  assert.match(proceduralTrees, /const cardCount = 4/);
  assert.match(proceduralTrees, /center\.add\(shootDirection\.scale\(along\)\)/);
  assert.match(proceduralTrees, /function addPineNeedleTuft/);
  assert.match(proceduralTrees, /TREE_LOW_LIGHT_BRIGHTNESS/);
  assert.match(treeField, /lowLightAlbedoScale/);
});

test("tapers the Scots pine crown upward from its widest surviving whorl", () => {
  assert.match(proceduralTrees, /lerp\(0\.88, 0\.16, Math\.pow\(crownT, 0\.72\)\)/);
  assert.doesNotMatch(proceduralTrees, /Math\.sin\(Math\.min\(1, crownT/);
  assert.match(proceduralTrees, /species === "pine"\s*\? 0\.93 \+ random\(\) \* 0\.1/);
});

test("selects a bounded sister-tree palette at application-tile scale", () => {
  assert.match(treeField, /const TREE_SISTER_MODELS = 4/);
  assert.match(treeField, /const TREE_VARIANT_SPAN_TILES = 256/);
  assert.match(treeField, /const tileVariantLocation = sceneToLonLat/);
  assert.match(treeField, /proceduralLocalVariantAtLocation\([\s\S]*?TREE_SISTER_MODELS,[\s\S]*?TREE_VARIANT_SPAN_TILES,[\s\S]*?0/);
  assert.match(treeField, /\/local\/\$\{tileLocalVariant\}\/season/);
  assert.match(treeField, /sister-\$\{tileLocalVariant\}/);
});

test("scales pine up and spruce down", () => {
  assert.match(treeField, /pine: 1\.16/);
  assert.match(treeField, /spruce: 0\.86/);
  assert.match(treeField, /\* speciesScale/);
});
