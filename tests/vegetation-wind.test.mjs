import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

const wind = source("Wind.ts");

test("wind affects grass, bushes, fern undergrowth, and tall plants", () => {
  assert.match(wind, /const SHEAR_FRACTIONS = \{ grass: [\d.]+, bush: [\d.]+, tree: [\d.]+ \}/);
  assert.match(source("GrassField.ts"), /windShearFraction\("grass"\)/);
  assert.match(source("BushField.ts"), /windShearFraction\("bush"\)/);
  assert.match(source("OpenStreetMapBarriers.ts"), /windShearFraction\("bush"\)/);
  assert.match(source("OpenStreetMapBarriers.ts"), /setVegetationWindShear\(/);
  assert.match(source("FernField.ts"), /windShearFraction\("grass"\)/);
  assert.match(source("FernField.ts"), /setVegetationWindShear\(\[fern, fernModel\]/);
  assert.match(source("TallPlantField.ts"), /windShearFraction\("grass"\)/);
  assert.match(source("TallPlantField.ts"), /setVegetationWindShear\(\[plants, plantModel\]/);
});

test("trees use one static atlas pose and static live geometry", () => {
  assert.doesNotMatch(source("TreeImpostor.ts"), /wind: \{|treeWind|setVegetationWindSway/);
  assert.doesNotMatch(source("TreeImpostorValidation.ts"), /setWindPhaseOverride/);
});

test("impostor atlases have no obsolete time-sample dimension", () => {
  for (const file of ["Impostor.ts", "TreeField.ts", "TreeImpostorValidation.ts"]) {
    assert.doesNotMatch(source(file), /timeSamples|time-samples|setTimePhase/);
  }
  assert.doesNotMatch(
    source("procedural/ProceduralCaptureMaterial.ts"),
    /windSway|setVegetationWindPhase|setWindPhaseOverride/,
  );
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
