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
const shadowSource = readFileSync(
  new URL("../src/CloudShadows.ts", import.meta.url),
  "utf8",
);
const terrainMaterialSource = readFileSync(
  new URL("../src/TerrainMaterial.ts", import.meta.url),
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
  assert.ok(counts.sparse > counts.dense);
  assert.ok(counts.dense > counts.clear);
  assert.ok(counts.clear > 600);
  assert.ok(counts.dense > 1_500);
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
    (cloud) => cloud.width * metersPerUnit >= 9_000 * weather.sizeScale,
  ));
  assert.ok(placements.every(
    (cloud) => cloud.height * metersPerUnit >= 9_000 / 2.15 * weather.sizeScale,
  ));
  assert.ok(placements.every((cloud) => {
    const aspectRatio = cloud.width / cloud.height;
    return aspectRatio >= 1.65 && aspectRatio <= 2.15;
  }));
  assert.ok(placements.every((cloud) => cloud.y * metersPerUnit === 7_000));
  assert.ok(placements.every((cloud) => (
    cloud.depth / cloud.width >= 0.42 && cloud.depth / cloud.width <= 0.62
  )));
});

test("volume capture retains continuous density for runtime blending", () => {
  assert.match(volumeSource, /CLOUD_CAPTURE_STEPS = 24/);
  assert.match(volumeSource, /opticalDepthGain = lerp\([\s\S]*?4\.2,[\s\S]*?5\.8/);
  assert.match(volumeSource, /1 - Math\.exp\(-opticalDepth \* opticalDepthGain\)/);
  assert.match(volumeSource, /pixels\[target\] = Math\.round\(clamp01\(coverage\) \* 255\)/);
  assert.doesNotMatch(volumeSource, /coverage\s*[<>]=?\s*0\.5/);
});

test("cloud bodies favor opaque mass over low-alpha mist", () => {
  assert.match(source, /bodyCoverage = smoothstep\(0\.025, 0\.78, density\.r\)/);
  assert.match(source, /mix\(1\.06, 0\.58, core\)/);
  assert.match(volumeSource, /density \* \(0\.78 \+ detail \* 0\.42\) - 0\.08/);
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
  assert.match(source, /mod\(tileIndex, atlasColumns\)/);
});

test("cloud impostors blend adjacent azimuth captures for 3D view changes", () => {
  assert.match(volumeSource, /CLOUD_VIEW_COUNT = 8/);
  assert.match(volumeSource, /variant \* CLOUD_VIEW_COUNT \+ view/);
  assert.match(source, /atan\(vViewDirection\.x, vViewDirection\.z\)/);
  assert.match(source, /sampleCloudDensity\(variant, firstView \+ 1\.0\)/);
});

test("cloud visibility is independent from the streamed terrain fog", () => {
  assert.match(source, /CLOUD_FAR_FADE_END_METERS = 18_000/);
  assert.match(source, /cloudPlacementsAround\([\s\S]*?CLOUD_FAR_FADE_END_METERS/);
  assert.doesNotMatch(source, /scene\.fogEnd \* metersPerUnit/);
});

test("manual cloud density overrides seeded occupancy and updates live", () => {
  const none = cloudPlacementsAround(0, 0, 30_000, 50, 42, 0);
  const full = cloudPlacementsAround(0, 0, 30_000, 50, 42, 1);
  assert.equal(none.length, 0);
  assert.ok(full.length > 0);
  assert.match(source, /setDensity\(nextDensity: number\)/);
  assert.match(source, /cloudPlacementsAround\([\s\S]*?density/);
});

test("the cloud field drifts together in the prevailing wind", () => {
  assert.match(source, /copyPrevailingWindDirectionTo\(driftDirection\)/);
  assert.match(source, /mesh\.position\.set\(driftX, 0, driftZ\)/);
  assert.match(source, /cameraPosition\.x - driftX/);
  assert.match(source, /cameraPosition\.z - driftZ/);
});

test("cloud shadows project the nearest top-down impostors onto terrain", () => {
  assert.match(volumeSource, /generateCloudShadowAtlasData/);
  assert.match(shadowSource, /TERRAIN_CLOUD_SHADOW_COUNT = 4/);
  assert.match(shadowSource, /cloud\.x \+ driftX - sunDirection\.x \* projectionDistance/);
  assert.match(shadowSource, /smoothstep\(0\.04, 0\.18, sunDirection\.y\)/);
  assert.match(shadowSource, /1 \/ \(candidate\.cloud\.width \* atlasFootprintScale\.x\)/);
  assert.doesNotMatch(shadowSource, /RenderTargetTexture/);
  assert.doesNotMatch(shadowSource, /ShadowGenerator/);
});

test("cloud shadow density integrates along the current sun ray", () => {
  assert.match(volumeSource, /generateCloudShadowAtlasData\([\s\S]*?sunDirection/);
  assert.match(volumeSource, /baseX \+ raySlopeX \* sampleY/);
  assert.match(volumeSource, /baseZ \+ raySlopeZ \* sampleY/);
  assert.match(volumeSource, /cloudShadowFootprintScale/);
  assert.match(shadowSource, /CLOUD_SHADOW_DIRECTION_REFRESH_RADIANS/);
  assert.match(shadowSource, /atlas\.texture\.update\(generateCloudShadowAtlasData\(sunDirection\)\.pixels\)/);
  assert.match(shadowSource, /candidate\.cloud\.width \* atlasFootprintScale\.x/);
});

test("terrain samples nearby cloud density directly in world space", () => {
  assert.match(terrainMaterialSource, /createCloudShadowTerrainMaterial/);
  assert.match(shadowSource, /vCloudShadowWorldXZ = worldPos\.xz/);
  assert.match(shadowSource, /sampleProjectedCloudShadow/);
  assert.match(shadowSource, /texture2D\([\s\S]*?cloudShadowAtlas/);
  assert.match(shadowSource, /cloudShadowCoverage \* cloudShadowLighting\.x \* \$\{CLOUD_SHADOW_DARKNESS\}/);
});

test("cloud shadow texture samples use uniform fragment control flow", () => {
  assert.doesNotMatch(
    shadowSource,
    /if \(min\(edgeDistance\.x, edgeDistance\.y\) <= 0\.0\) return 0\.0/,
  );
  assert.match(shadowSource, /localUV = clamp\(localUV, vec2\(0\.0\), vec2\(1\.0\)\)/);
  assert.match(shadowSource, /edgeFade \* placementEnabled/);
});
