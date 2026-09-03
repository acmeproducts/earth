import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

test("upper-hemisphere impostors remap side capture and runtime sampling together", () => {
  const captureSource = source("Impostor.ts");
  const shaderSource = source("TreeField.ts");

  assert.match(captureSource, /upperHemisphereOnly && isSideFace/);
  assert.match(captureSource, /\(fullRangeV \+ 1\) \* 0\.5/);
  assert.match(shaderSource, /upperHemisphereOnly > 0\.5 && topFacing < 0\.5/);
  assert.match(shaderSource, /normalizedSamplePosition\.y = projected\.y/);
});

test("all non-tree vegetation opts in while trees retain the full range", () => {
  for (const name of [
    "GrassImpostor.ts",
    "TallPlantImpostor.ts",
    "BushImpostor.ts",
    "FernImpostor.ts",
  ]) {
    assert.match(source(name), /upperHemisphereOnly: true/);
  }
  assert.doesNotMatch(source("TreeImpostor.ts"), /upperHemisphereOnly: true/);
});

test("bush impostors preserve their asymmetric regional silhouettes at runtime", () => {
  const bushSource = source("BushImpostor.ts");

  assert.match(bushSource, /faces: IMPOSTOR_CUBE_FACES/);
  assert.match(bushSource, /rotationallySymmetric: false/);
  assert.match(bushSource, /horizontalSamples: \{ default: 5,/);
  assert.match(bushSource, /const radiusAtAngle/);
  assert.doesNotMatch(bushSource, /ROTATIONAL_SYMMETRY_ORDER|for \(let copy/);
});

test("impostor sampling defaults do not exceed five views per axis", () => {
  for (const name of [
    "BushImpostor.ts",
    "FernImpostor.ts",
    "GrassImpostor.ts",
    "RockyBeachImpostor.ts",
    "TallPlantImpostor.ts",
    "TreeImpostor.ts",
    "WheatImpostor.ts",
  ]) {
    const impostorSource = source(name);
    const horizontalDefault = impostorSource.match(/horizontalSamples: \{ default: (\d+),/)?.[1];
    const verticalDefault = impostorSource.match(/verticalSamples: \{ default: (\d+),/)?.[1];

    assert.ok(horizontalDefault, `${name} declares a horizontal sampling default`);
    assert.ok(verticalDefault, `${name} declares a vertical sampling default`);
    assert.ok(Number(horizontalDefault) <= 5, `${name} horizontal sampling is capped at 5`);
    assert.ok(Number(verticalDefault) <= 5, `${name} vertical sampling is capped at 5`);
  }
});
