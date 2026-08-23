import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isFloatShadowTexture,
  unpackVegetationShadowDepth,
  VEGETATION_SHADOW_RECEIVER_BIAS,
  vegetationShadowVisibilityFromSamples,
} from "../src/VegetationShadowReceiver.ts";

const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");
const impostors = readFileSync(new URL("../src/TreeField.ts", import.meta.url), "utf8");
const models = readFileSync(
  new URL("../src/ProceduralCaptureMaterial.ts", import.meta.url),
  "utf8",
);
const receivers = readFileSync(
  new URL("../src/VegetationShadowReceiver.ts", import.meta.url),
  "utf8",
);
const cloudReceivers = readFileSync(
  new URL("../src/CloudShadows.ts", import.meta.url),
  "utf8",
);
const solarLighting = readFileSync(
  new URL("../src/SolarLighting.ts", import.meta.url),
  "utf8",
);

test("keeps low vegetation out of the tree and sapling shadow-caster list", () => {
  assert.match(
    game,
    /filter\(\(kind\) => kind === "treeField" \|\| kind === "saplingField"\)/,
  );
  assert.match(game, /field\.shadowCasterMeshes : field\.meshes/);
  assert.match(game, /setShadowCasters\(casters\)/);
});

test("roads and lake surfaces receive shadows without casting ground streaks", () => {
  assert.match(game, /for \(const mesh of mapMeshes\) mesh\.receiveShadows = true/);
  assert.match(game, /mapMeshes\.filter\(\(mesh\) => mesh\.name === "buildings"\)/);
});

test("WebGPU terrain receives building shadows without self-shadow acne", () => {
  assert.match(game, /record\.terrain\.receiveShadows = true/);
  assert.match(game, /if \(!this\.engine\.isWebGPU\) casters\.push\(record\.terrain\)/);
  assert.match(game, /this\.solarLighting\?\.setShadowCasters\(casters\)/);
  assert.doesNotMatch(game, /if \(casters\.length > 0\) this\.solarLighting/);
});

test("trees cast through dedicated impostor shadow geometry at every renderer", () => {
  assert.match(impostors, /function createTreeShadowCasters/);
  assert.match(impostors, /const caster = new Mesh\(`treeShadow-/);
  assert.match(impostors, /VertexData\.ExtractFromMesh\(source, true, true\)/);
  assert.doesNotMatch(impostors, /source\.geometry\.applyToMesh\(caster\)/);
  assert.match(impostors, /thinInstanceSetBuffer\("matrix", matrices, 16, true\)/);
  assert.match(impostors, /"instanceLodBlend",[\s\S]*?new Float32Array\(matrices\.length \/ 16\)/);
  assert.match(impostors, /shadowOnly: true/);
  assert.match(solarLighting, /shadowMap\?\.onBeforeRenderObservable\.add/);
  assert.match(solarLighting, /shadowMap\?\.onAfterRenderObservable\.add/);
  assert.doesNotMatch(impostors, /getEngine\(\)\.isWebGPU \|\| modelMeshes\.length/);
  assert.match(
    game,
    /field\.shadowCasterMeshes\.length > 0 \? field\.shadowCasterMeshes : field\.meshes/,
  );
});

test("medium-range tree shadows use the full field instead of visual LOD buffers", () => {
  assert.match(impostors, /createTreeShadowCasters\([\s\S]*?ownMatrices/);
  assert.match(impostors, /thinInstanceSetBuffer\("matrix", matrices, 16, true\)/);
  const shadowRefresh = game.slice(
    game.indexOf("private refreshShadowCasters"),
    game.indexOf("private enableWaterReflections"),
  );
  assert.doesNotMatch(shadowRefresh, /modelMeshes|impostorMeshes|modelRangeMeters/);
});

test("low vegetation commits do not rebuild the expensive shadow caster list", () => {
  const commit = game.slice(
    game.indexOf("private commitTileField"),
    game.indexOf("private refreshShadowCasters"),
  );
  assert.match(
    commit,
    /if \(kind === "treeField" \|\| kind === "saplingField"\) this\.refreshShadowCasters\(\)/,
  );
});

test("keeps foliage alpha and LOD masks in model and impostor shadow passes", () => {
  assert.match(models, /new ShadowDepthWrapper\(material, scene/);
  assert.match(models, /if \(leafSample\.a < 0\.5\) discard/);
  assert.match(models, /vInstanceLodBlend <= bayer4/);
  assert.match(impostors, /new ShadowDepthWrapper\(material, scene/);
  assert.match(impostors, /vInstanceLodBlend > bayer4/);
  assert.match(impostors, /#if SM_DIRECTIONINLIGHTDATA == 1\s+vec3 direction = normalize\(vLocalSunDirection\)/);
});

test("does not rerender the static shadow map for camera-relative LOD changes", () => {
  const lodUpdate = game.slice(
    game.indexOf("private updateVegetationLod"),
    game.indexOf("private logVegetationLodStats"),
  );
  assert.doesNotMatch(lodUpdate, /refreshShadows\(\)/);
});

test("refreshes shadows throughout streamed layer cross-fades", () => {
  const fades = game.slice(
    game.indexOf("private updateLayerFades"),
    game.indexOf("private commitTileField"),
  );
  assert.match(fades, /this\.solarLighting\?\.refreshShadows\(\)/);
});

test("grass models and impostors share terrain-root shadow sampling", () => {
  assert.match(impostors, /vegetationShadowAtInstanceRoot/);
  assert.match(models, /vegetationShadowAtInstanceRoot/);
  assert.match(impostors, /finalWorld \* vec4\(0\.0, 0\.0, 0\.0, 1\.0\)/);
  assert.match(models, /finalWorld \* vec4\(0\.0, 0\.0, 0\.0, 1\.0\)/);
});

test("shadows custom vegetation direct light while preserving ambient light", () => {
  for (const shader of [impostors, models]) {
    assert.match(shader, /float shadowVisibility = vegetationShadowVisibility\(\)/);
    assert.match(
      shader,
      /ambientColor \+ sunColor \* \(0\.16 \+ direct \* 0\.62\) \* shadowVisibility/,
    );
    assert.doesNotMatch(shader, /lighting \*= vegetationShadowVisibility\(\)/);
  }
  assert.match(receivers, /uniform sampler2D vegetationShadowSampler/);
  assert.doesNotMatch(receivers, /sampler2DShadow/);
  assert.match(receivers, /visibility \/= 9\.0/);
  assert.match(receivers, /SM_DIRECTIONINLIGHTDATA == 1/);
  assert.match(receivers, /scene\.onBeforeRenderObservable\.add\(updateShadowUniforms\)/);
  assert.doesNotMatch(receivers, /material\.onBindObservable\.add/);
});

test("cloud footprints shadow both vegetation models and impostors", () => {
  for (const shader of [impostors, models]) {
    assert.match(shader, /cloudShadowVertexDeclaration/);
    assert.match(shader, /cloudShadowFragmentDeclaration/);
    assert.match(shader, /vCloudShadowWorldXZ = instanceOrigin\.xz/);
    assert.match(shader, /bindCloudShadowReceiver\(material, scene\)/);
  }
  assert.match(impostors, /lighting \*= vegetationCloudShadowVisibility\(\)/);
  assert.match(
    models,
    /lighting \*= mix\(1\.0, vegetationCloudShadowVisibility\(\), lightingEnabled\)/,
  );
  assert.match(cloudReceivers, /uniform sampler2D cloudShadowAtlas/);
  assert.match(cloudReceivers, /CLOUD_SHADOW_DARKNESS = 0\.36/);
  assert.match(
    cloudReceivers,
    /coverage \* cloudShadowLighting\.x \* \$\{CLOUD_SHADOW_DARKNESS\}/,
  );
  assert.match(cloudReceivers, /material\.setTexture\("cloudShadowAtlas", texture\)/);
});

test("unpacks Babylon's unsigned-byte fallback before comparing grass shadows", () => {
  // Babylon's pack() stores the most significant depth component in alpha.
  // This sample represents 0.625 plus successively smaller packed components.
  const packed = [0.25, 0.5, 0.75, 0.625];
  const expected = 0.625 + 0.75 / 255 + 0.5 / (255 ** 2) + 0.25 / (255 ** 3);
  assert.ok(Math.abs(unpackVegetationShadowDepth(packed) - expected) < 1e-12);
  assert.equal(isFloatShadowTexture(0), false);
  assert.equal(isFloatShadowTexture(1), true);
  assert.equal(isFloatShadowTexture(2), true);
  assert.match(receivers, /mix\(packedDepth, shadowSample\.r, vegetationShadowFloatTexture\)/);
});

test("packed caster depth visibly darkens grass receiver samples", () => {
  const shadowedSamples = Array.from({ length: 9 }, () => [0, 0, 0, 0.4]);
  const litSamples = Array.from({ length: 9 }, () => [0, 0, 0, 0.9]);
  assert.equal(
    vegetationShadowVisibilityFromSamples(0.7, shadowedSamples, false, 0.3),
    0.3,
  );
  assert.equal(
    vegetationShadowVisibilityFromSamples(0.7, litSamples, false, 0.3),
    1,
  );
});

test("non-grazing shallow depth separation still shadows grass", () => {
  assert.match(solarLighting, /directLight\.autoCalcShadowZBounds = true/);
  const receiverDepth = 0.5;
  const casterDepth = receiverDepth - VEGETATION_SHADOW_RECEIVER_BIAS * 2;
  const samples = Array.from({ length: 9 }, () => [casterDepth, 0, 0, 1]);
  assert.equal(
    vegetationShadowVisibilityFromSamples(receiverDepth, samples, true, 0.3),
    0.3,
  );
});

test("scene changes invalidate cached directional shadow bounds", () => {
  const setCasters = solarLighting.slice(
    solarLighting.indexOf("setShadowCasters"),
    solarLighting.indexOf("private currentLightingDate"),
  );
  assert.match(setCasters, /directLight\.forceProjectionMatrixCompute\(\)/);
  assert.match(solarLighting, /directLight\.autoUpdateExtends = true/);
});
