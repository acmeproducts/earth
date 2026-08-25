import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { shouldUpdateSolarLocation } from "../src/SolarLocation.ts";

const source = readFileSync(new URL("../src/SolarLighting.ts", import.meta.url), "utf8");

test("does not rebuild celestial render targets at every streamed tile boundary", () => {
  assert.equal(shouldUpdateSolarLocation(52, 13, 52.004, 13.006), false);
  assert.equal(shouldUpdateSolarLocation(52, 13, 52.06, 13), true);
});

test("solar location movement uses the short path across the antimeridian", () => {
  assert.equal(shouldUpdateSolarLocation(0, 179.99, 0, -179.99), false);
  assert.equal(shouldUpdateSolarLocation(0, 179.9, 0, -179.9), true);
});

test("updates the visible atmosphere more often than shadows and reflections", () => {
  assert.match(source, /ATMOSPHERE_UPDATE_INTERVAL_MS = 5_000/);
  assert.match(source, /SHADOW_UPDATE_INTERVAL_MS = 60_000/);
  assert.match(source, /if \(updateAtmosphere\) \{/);
  assert.match(
    source,
    /if \(updateShadowTargets\) \{[\s\S]*?forceProjectionMatrixCompute\(\)[\s\S]*?resetRefreshCounter\(\)[\s\S]*?refreshStaticShadows\(\)/,
  );
});

test("spends more of the cached shadow map on streamed caster detail", () => {
  assert.match(source, /const PREFERRED_SHADOW_MAP_SIZE = 4096/);
  assert.match(source, /const SHADOW_ORTHO_SCALE = 0\.02/);
  assert.match(
    source,
    /Math\.min\([\s\S]*?PREFERRED_SHADOW_MAP_SIZE,[\s\S]*?getCaps\(\)\.maxTextureSize/,
  );
  assert.match(source, /directLight\.shadowOrthoScale = SHADOW_ORTHO_SCALE/);
});

test("avoids four-level Poisson banding without replacing vegetation depth", () => {
  assert.doesNotMatch(source, /usePoissonSampling = true/);
  assert.match(source, /useContactHardeningShadow = true/);
  assert.match(source, /filteringQuality = ShadowGenerator\.QUALITY_MEDIUM/);
  assert.match(source, /const SHADOW_LIGHT_SIZE_UV_RATIO = 0\.025/);
  assert.match(
    source,
    /contactHardeningLightSizeUVRatio = SHADOW_LIGHT_SIZE_UV_RATIO/,
  );
});
