import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const water = readFileSync(new URL("../src/Water.ts", import.meta.url), "utf8");

test("flat water does not carry a redundant triangle grid", () => {
  assert.match(water, /subdivisions = 1/);
  assert.match(water, /\{ width: width \* 1\.2, height: height \* 1\.2, subdivisions \}/);
});

test("the two wave layers cannot reinforce an aligned square repeat", () => {
  const ratio = Number(water.match(/const CHOP_TILE_RATIO = ([\d.]+)/)?.[1]);
  assert.ok(Number.isFinite(ratio));
  assert.notEqual(ratio, Math.round(ratio));
  assert.match(water, /swell\.uOffset = 0\.173/);
  assert.match(water, /chop\.uOffset = 0\.631/);
});
