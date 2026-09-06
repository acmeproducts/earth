import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NullEngine, Scene, ShaderMaterial } from "@babylonjs/core";
import { bindWindPhase, currentWindLoopPhase } from "../src/Wind.ts";

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

test("materials share a wind sample across a loop boundary and advance next frame", (t) => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  let now = 3599;
  let frame = 1;
  t.mock.method(performance, "now", () => now);
  t.mock.method(scene, "getFrameId", () => frame);
  const model = new ShaderMaterial("model", scene, {}, {});
  const impostor = new ShaderMaterial("impostor", scene, {}, {});
  bindWindPhase(model);
  now = 3601;
  bindWindPhase(impostor);
  assert.equal(model._floats.windPhase, impostor._floats.windPhase);
  assert.equal(model._floats.windStrength, impostor._floats.windStrength);
  assert.deepEqual(model._vectors2.windDirection, impostor._vectors2.windDirection);
  const frequency = model._vectors2.windGustFrequency.asArray();
  frame++;
  bindWindPhase(impostor);
  assert.equal(impostor._floats.windPhase, currentWindLoopPhase(now));
  assert.ok(impostor._floats.windPhase < 0.001);
  now = 90_000;
  frame++;
  bindWindPhase(impostor);
  assert.deepEqual(impostor._vectors2.windGustFrequency.asArray(), frequency,
    "weather direction changes must not rephase the spatial gust field");
});
