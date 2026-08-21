import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

const wind = source("Wind.ts");
const treeImpostor = source("TreeImpostor.ts");

test("wind affects grass and bushes only", () => {
  assert.match(wind, /const SHEAR_FRACTIONS = \{ grass: [\d.]+, bush: [\d.]+ \}/);
  assert.doesNotMatch(wind, /TREE_SWAY_FRACTION|TREE_TIME_SAMPLES|flower:/);
  assert.match(source("GrassField.ts"), /windShearFraction\("grass"\)/);
  assert.match(source("BushField.ts"), /windShearFraction\("bush"\)/);
  assert.doesNotMatch(source("FlowerField.ts"), /Wind|setVegetationWindShear|windShearFraction/);
});

test("trees use one static atlas pose and static live geometry", () => {
  assert.doesNotMatch(treeImpostor, /wind: \{|treeWind|setVegetationWindSway/);
  assert.doesNotMatch(source("TreeImpostorValidation.ts"), /setWindPhaseOverride/);
});

test("the grass ripple joins continuously at the loop boundary", () => {
  assert.match(wind, /float ripple = windPhase \* 2\.0/);
  assert.doesNotMatch(wind, /windPhase \* 1\.7/);
  for (const spatialPhase of [0, 0.17, 0.63, 1.4]) {
    const bend = (phase) => (
      Math.sin(2 * Math.PI * (phase + spatialPhase)) * 0.74
      + Math.sin(2 * Math.PI * (phase * 2 + spatialPhase * 5)) * 0.26
    );
    assert.ok(Math.abs(bend(0) - bend(1)) < 1e-12);
  }
});

test("gusts travel through the world rather than pulsing in place", () => {
  assert.match(wind, /float windLoopPhase\(vec3 instanceOrigin\)/);
  assert.match(wind, /windPhase \+ dot\(instanceOrigin\.xz, windGustFrequency\)/);
  assert.match(wind, /metersPerUnit \/ GUST_WAVELENGTH_METERS/);
  assert.match(source("Game.ts"), /configureWindSceneScale\(metersPerUnit\)/);
});

test("an absent wind parameter is not read as a request for stillness", () => {
  assert.match(wind, /if \(raw === null\) return 1/);
});
