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
const solarLighting = readFileSync(
  new URL("../src/SolarLighting.ts", import.meta.url),
  "utf8",
);

test("registers both vegetation models and impostors as shadow casters", () => {
  for (const field of ["treeField", "grassField", "flowerField", "bushField"]) {
    assert.match(game, new RegExp(`\\.\\.\\.${field}\\.meshes`));
  }
});

test("keeps foliage alpha and LOD masks in model and impostor shadow passes", () => {
  assert.match(models, /new ShadowDepthWrapper\(material, scene/);
  assert.match(models, /if \(leafSample\.a < 0\.5\) discard/);
  assert.match(models, /vInstanceLodBlend <= bayer4/);
  assert.match(impostors, /new ShadowDepthWrapper\(material, scene/);
  assert.match(impostors, /vInstanceLodBlend > bayer4/);
  assert.match(impostors, /#if SM_DIRECTIONINLIGHTDATA == 1\s+vec3 direction = normalize\(vLocalSunDirection\)/);
});

test("refreshes the static shadow map after vegetation LOD changes", () => {
  assert.match(game, /if \(shadowsChanged\) this\.solarLighting\?\.refreshShadows\(\)/);
});

test("darkens custom vegetation with the regular sun depth texture", () => {
  assert.match(impostors, /lighting \*= vegetationShadowVisibility\(\)/);
  assert.match(models, /lighting \*= vegetationShadowVisibility\(\)/);
  assert.match(receivers, /uniform sampler2D vegetationShadowSampler/);
  assert.doesNotMatch(receivers, /sampler2DShadow/);
  assert.match(receivers, /visibility \/= 9\.0/);
  assert.match(receivers, /SM_DIRECTIONINLIGHTDATA == 1/);
  assert.match(receivers, /scene\.onBeforeRenderObservable\.add\(updateShadowUniforms\)/);
  assert.doesNotMatch(receivers, /material\.onBindObservable\.add/);
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
