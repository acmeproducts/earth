import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fieldSource = readFileSync(new URL("../src/GrassField.ts", import.meta.url), "utf8");
const impostorSource = readFileSync(new URL("../src/TreeField.ts", import.meta.url), "utf8");
const modelSource = readFileSync(
  new URL("../src/ProceduralCaptureMaterial.ts", import.meta.url),
  "utf8",
);

test("grass instances inherit their local rendered ground color", () => {
  assert.match(fieldSource, /varyGroundColor\(/);
  assert.match(fieldSource, /landCoverSurfaceColor\(landCover\)/);
  assert.match(fieldSource, /colors\.push\(\.\.\.grassGroundColorMultiplier/);
  assert.match(fieldSource, /new Float32Array\(colors\)/);
});

test("grass applies the tint consistently to models and impostors", () => {
  assert.match(fieldSource, /instanceColorCoverage", 0\.8/g);
  assert.match(impostorSource, /max\(petalMask, instanceColorCoverage\)/);
  assert.match(modelSource, /max\(petalMask, instanceColorCoverage\)/);
  assert.match(impostorSource, /setFloat\("instanceColorCoverage", 0\)/);
  assert.match(modelSource, /setFloat\("instanceColorCoverage", 0\)/);
});
