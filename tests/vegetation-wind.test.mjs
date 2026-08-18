import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

const wind = source("Wind.ts");
const captureMaterial = source("ProceduralCaptureMaterial.ts");
const impostor = source("Impostor.ts");
const treeImpostor = source("TreeImpostor.ts");
const treeField = source("TreeField.ts");

test("one shared shader displaces both the capture source and the live model", () => {
  // An impostor frame is only the model's own pose if the same code produced
  // both, so the displacement must live in exactly one place.
  assert.match(wind, /export const windSwayVertexDeclaration/);
  assert.equal((captureMaterial.match(/windSwayOffset\(/g) ?? []).length, 1);
  assert.doesNotMatch(treeField, /windSwayOffset/);
  assert.match(captureMaterial, /windSwayVertexDeclaration/);
  assert.match(captureMaterial, /vec3 swayPosition = position/);
  assert.match(captureMaterial, /finalWorld \* vec4\(swayPosition, 1\.0\)/);
});

test("sway is measured from the model base so any scale of it agrees", () => {
  // A capture source is centered on the origin and the live model stands on
  // y = 0. Normalizing against the base cancels that difference, and the
  // height division cancels the render scale.
  assert.match(
    wind,
    /vec3 normalized = \(localPosition - vec3\(0\.0, windModelBaseY, 0\.0\)\)\s*\/ max\(windModelHeight, 0\.0001\)/,
  );
  assert.match(impostor, /-definition\.sourceHeight \/ 2,\s+definition\.sourceHeight,/);
  assert.match(treeImpostor, /setVegetationWindSway\(\[tree\], treeWindSwayFraction\(\), 0, renderHeight\)/);
});

test("the loop stays on its fundamental so few captured moments suffice", () => {
  // Four samples reconstruct a sine. Vertices may differ in phase, but a
  // harmonic or a per-vertex frequency would alias between captured frames.
  assert.match(wind, /float angle = 6\.28318530718 \* loopPhase - lag/);
  assert.match(wind, /return vec3\(sin\(angle\), 0\.0, sin\(angle \+ 1\.9\) \* 0\.35\)/);
  assert.doesNotMatch(wind, /loopPhase \* [2-9]/);
});

test("trees trade directional samples for captured moments of the loop", () => {
  assert.match(treeImpostor, /horizontalSamples: \{ default: 4,/);
  assert.match(treeImpostor, /verticalSamples: \{ default: 4,/);
  assert.match(treeImpostor, /timeSamples: \{ default: treeWindTimeSamples\(\), minimum: 1, maximum: 8 \}/);
  assert.match(treeImpostor, /swayFraction: treeWindSwayFraction\(\)/);
});

test("only the tree atlas pays for a captured wind dimension", () => {
  for (const name of ["GrassImpostor.ts", "FlowerImpostor.ts", "BushImpostor.ts"]) {
    assert.doesNotMatch(source(name), /wind: \{/);
  }
});

test("moments extend the atlas along its columns, and every consumer knows it", () => {
  assert.match(impostor, /const atlasColumns = gridWidth \* timeSamples/);
  assert.match(impostor, /const atlasWidth = atlasColumns \* resolutionWidth/);
  assert.match(impostor, /column \/ atlasColumns,/);
  assert.match(impostor, /1 \/ atlasColumns,/);
  // The still pose leads the loop, so a motionless capture is column zero and
  // the tools that read raw atlas tiles keep working.
  assert.match(impostor, /setTimePhase\?\.\(timeIndex \/ timeSamples\)/);
  // Direction math keeps the unmultiplied grid; only UV division changes.
  assert.match(treeField, /vec2 atlasUV = \(tile \+ localUV\) \/ atlasTileCounts/);
  assert.doesNotMatch(treeField, /\/ gridDimensions;/);
  assert.match(treeField, /samplePosition = clamp\(normalizedSamplePosition, 0\.0, 1\.0\) \* \(gridDimensions - 1\.0\)/);
  assert.match(source("TreeImpostorValidation.ts"), /atlasSample\(\(tile \+ localUV\) \/ atlasTileCounts\)/);
});

test("the impostor dithers between moments instead of cross-fading them", () => {
  // The atlas is alpha tested, so consecutive moments blend exactly the way
  // neighboring directions already do, on an independent dither pattern.
  assert.match(treeField, /float timeChoice = bayer4\(gl_FragCoord\.xy \+ vec2\(3\.0, 2\.0\)\)/);
  assert.match(treeField, /mod\(earlierMoment \+ 1\.0, timeSamples\)/);
  assert.match(treeField, /timeColumn = moment \* gridDimensions\.x/);
  for (const tile of [
    /frame\(face, vec2\(low\.x \+ timeColumn, low\.y\)/,
    /frame\(face, vec2\(high\.x \+ timeColumn, low\.y\)/,
    /frame\(face, vec2\(low\.x \+ timeColumn, high\.y\)/,
    /frame\(face, vec2\(high\.x \+ timeColumn, high\.y\)/,
  ]) assert.match(treeField, tile);
});

test("gusts travel through the world rather than pulsing in place", () => {
  assert.match(wind, /float windLoopPhase\(vec3 instanceOrigin\)/);
  assert.match(wind, /windPhase \+ dot\(instanceOrigin\.xz, windGustFrequency\)/);
  // Per-instance phase reaches both shaders through their instance matrix.
  for (const shader of [treeField, captureMaterial]) {
    assert.match(shader, /vec3 instanceOrigin = finalWorld\[3\]\.xyz/);
    assert.match(shader, /windLoopPhase\(instanceOrigin\)/);
  }
  // Wavelength is a distance in meters, so it needs the scene's ground scale.
  assert.match(wind, /metersPerUnit \/ GUST_WAVELENGTH_METERS/);
  assert.match(source("Game.ts"), /configureWindSceneScale\(metersPerUnit\)/);
});

test("a swayed silhouette still fits inside its capture frame", () => {
  assert.match(impostor, /captureWidth \+= 2 \* windSwayReach\(definition\.sourceHeight, swayFraction\)/);
  assert.match(wind, /return 1\.1 \* swayFraction \* modelHeight/);
});

test("an absent wind parameter is not read as a request for stillness", () => {
  assert.match(wind, /if \(raw === null\) return 1/);
  assert.match(wind, /strengthScale > 0 \? TREE_TIME_SAMPLES : 1/);
});
