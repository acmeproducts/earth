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
    "FlowerImpostor.ts",
    "BushImpostor.ts",
    "FernImpostor.ts",
  ]) {
    assert.match(source(name), /upperHemisphereOnly: true/);
  }
  assert.doesNotMatch(source("TreeImpostor.ts"), /upperHemisphereOnly: true/);
});

test("bush impostors preserve their finite procedural symmetry at runtime", () => {
  const bushSource = source("BushImpostor.ts");

  assert.match(bushSource, /const ROTATIONAL_SYMMETRY_ORDER = 12/);
  assert.match(bushSource, /rotationalSymmetryOrder: ROTATIONAL_SYMMETRY_ORDER/);
  assert.match(bushSource, /horizontalSamples: \{ default: 5,/);
  assert.match(bushSource, /const symmetryOrder = ROTATIONAL_SYMMETRY_ORDER/);
});
