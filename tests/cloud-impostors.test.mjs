import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CLOUD_VARIANT_COUNT,
  cloudPlacementsAround,
  cloudWeatherForSeed,
} from "../src/CloudDistribution.ts";

const source = readFileSync(new URL("../src/CloudImpostors.ts", import.meta.url), "utf8");
const volumeSource = readFileSync(
  new URL("../src/CloudVolumeCapture.ts", import.meta.url),
  "utf8",
);

test("cloud cells generate stable field-space placements", () => {
  const placements = cloudPlacementsAround(3, -2, 10_000, 50, 42);
  assert.ok(placements.length > 0);
  assert.deepEqual(placements, cloudPlacementsAround(3, -2, 10_000, 50, 42));

  const finerScale = cloudPlacementsAround(3, -2, 10_000, 25, 42);
  assert.equal(finerScale.length, placements.length);
  for (let index = 0; index < placements.length; index++) {
    assert.equal(finerScale[index].x * 25, placements[index].x * 50);
    assert.equal(finerScale[index].y * 25, placements[index].y * 50);
    assert.equal(finerScale[index].z * 25, placements[index].z * 50);
  }
});

test("cloud distribution responds to the world seed", () => {
  const first = cloudPlacementsAround(0, 0, 10_000, 50, 1);
  const second = cloudPlacementsAround(0, 0, 10_000, 50, 2);
  assert.notDeepEqual(first, second);
  assert.ok(first.every(
    (cloud) => cloud.variant >= 0 && cloud.variant < CLOUD_VARIANT_COUNT,
  ));
});

test("weather regimes use a deliberately uneven probability distribution", () => {
  const counts = { clear: 0, sparse: 0, scattered: 0, dense: 0 };
  for (let seed = 0; seed < 10_000; seed++) {
    counts[cloudWeatherForSeed(seed).kind]++;
  }
  assert.ok(counts.scattered > counts.sparse);
  assert.ok(counts.sparse > counts.clear);
  assert.ok(counts.clear > counts.dense);
  assert.ok(counts.clear > 1_000);
  assert.ok(counts.dense > 800);
});

test("clear, sparse, and dense regimes alter count and formation scale", () => {
  const seedFor = (kind) => {
    for (let seed = 0; seed < 10_000; seed++) {
      if (cloudWeatherForSeed(seed).kind === kind) return seed;
    }
    throw new Error(`No seed found for ${kind}`);
  };
  const clear = cloudPlacementsAround(0, 0, 30_000, 50, seedFor("clear"));
  const sparse = cloudPlacementsAround(0, 0, 30_000, 50, seedFor("sparse"));
  const dense = cloudPlacementsAround(0, 0, 30_000, 50, seedFor("dense"));
  assert.equal(clear.length, 0);
  assert.ok(sparse.length > 0);
  assert.ok(dense.length > sparse.length);
  assert.ok(
    Math.min(...dense.map((cloud) => cloud.width))
      > Math.min(...sparse.map((cloud) => cloud.width)),
  );
});

test("clouds share one altitude and form broad banks", () => {
  const metersPerUnit = 50;
  const placements = cloudPlacementsAround(0, 0, 10_000, metersPerUnit, 42);
  assert.ok(placements.length > 0);
  assert.equal(new Set(placements.map((cloud) => cloud.y)).size, 1);
  const weather = cloudWeatherForSeed(42);
  assert.ok(placements.every(
    (cloud) => cloud.width * metersPerUnit >= 10_000 * weather.sizeScale,
  ));
  assert.ok(placements.every(
    (cloud) => cloud.height * metersPerUnit >= 3_000 * weather.sizeScale,
  ));
});

test("volume capture retains continuous density for runtime blending", () => {
  assert.match(volumeSource, /CLOUD_CAPTURE_STEPS = 24/);
  assert.match(volumeSource, /1 - Math\.exp\(-opticalDepth \* 2\.8\)/);
  assert.match(volumeSource, /pixels\[target\] = Math\.round\(clamp01\(coverage\) \* 255\)/);
  assert.doesNotMatch(volumeSource, /coverage\s*[<>]=?\s*0\.5/);
});

test("cloud atlas contains eight distinct formation archetypes", () => {
  assert.equal(CLOUD_VARIANT_COUNT, 8);
  assert.match(volumeSource, /CLOUD_ATLAS_COLUMNS = 4/);
  assert.match(volumeSource, /variant % CLOUD_ATLAS_COLUMNS/);
  assert.match(volumeSource, /bankLobes[\s\S]*clusteredLobes[\s\S]*brokenLobes[\s\S]*towerLobes/);
});

test("cloud instances independently mirror repeated atlas variants", () => {
  const placements = cloudPlacementsAround(0, 0, 30_000, 50, 3);
  assert.ok(placements.some((cloud) => cloud.mirrored));
  assert.ok(placements.some((cloud) => !cloud.mirrored));
});

test("cloud impostors blend captured density without screen-space dithering", () => {
  assert.match(source, /needAlphaBlending:\s*true/);
  assert.match(source, /alphaMode = Constants\.ALPHA_COMBINE/);
  assert.doesNotMatch(source, /bayer|gl_FragCoord|discard/);
  assert.match(source, /gl_FragColor = vec4\([\s\S]*?, coverage\)/);
  assert.match(source, /mesh\.thinInstanceSetBuffer\("matrix"/);
  assert.match(source, /mesh\.thinInstanceSetBuffer\("cloudMirror"/);
  assert.match(source, /mod\(variant, atlasColumns\)/);
});

test("cloud visibility is independent from the streamed terrain fog", () => {
  assert.match(source, /CLOUD_FAR_FADE_END_METERS = 18_000/);
  assert.match(source, /cloudPlacementsAround\([\s\S]*?CLOUD_FAR_FADE_END_METERS/);
  assert.doesNotMatch(source, /scene\.fogEnd \* metersPerUnit/);
});

test("clear weather skips cloud GPU resource creation", () => {
  assert.match(
    source,
    /cloudWeatherForSeed\(weatherSeed\)\.occupancy === 0\) return undefined;[\s\S]*?createCloudDensityAtlas/,
  );
});

test("the cloud field drifts together in the prevailing wind", () => {
  assert.match(source, /copyPrevailingWindDirectionTo\(driftDirection\)/);
  assert.match(source, /mesh\.position\.set\(driftX, 0, driftZ\)/);
  assert.match(source, /cameraPosition\.x - driftX/);
  assert.match(source, /cameraPosition\.z - driftZ/);
});
