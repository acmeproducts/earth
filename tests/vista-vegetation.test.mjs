import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  chooseVistaVegetationSpacing,
  estimateVistaVegetationCandidates,
  vegetationDensityScaleAcrossLocalBoundary,
} from "../src/VistaVegetation.ts";

test("bounds extended-vista source generation so capture can actually complete", () => {
  const spacing = chooseVistaVegetationSpacing(10_000, 10_000);
  const candidates = estimateVistaVegetationCandidates(10_000, 10_000, spacing);
  assert.ok(spacing > 3.5, "a 100 km² vista must not use local-field spacing");
  assert.ok(candidates <= 752_000, `candidate count ${candidates} exceeded the capture budget`);
  assert.ok(candidates >= 740_000, `candidate count ${candidates} did not use the denser budget`);
});

test("smoothly blends vegetation density across the local-vista seam", () => {
  const sampleInner = (x) => vegetationDensityScaleAcrossLocalBoundary(
    x,
    0,
    50,
    50,
    { innerScale: 0.88, borderScale: 0.25, outerScale: 0.25, transitionWidth: 16 },
  );
  const sampleVista = (x) => vegetationDensityScaleAcrossLocalBoundary(
    x,
    0,
    50,
    50,
    { innerScale: 1, borderScale: 1, outerScale: 1.12, transitionWidth: 16 },
  );
  assert.equal(sampleInner(0), 0.88);
  assert.equal(sampleInner(50), 0.25);
  assert.ok(sampleInner(42) > sampleInner(50));
  assert.equal(sampleVista(50), 1);
  assert.equal(sampleVista(66), 1.12);
  assert.ok(sampleVista(58) > sampleVista(50));
});

test("matches actual tree density when local and vista grids use different spacing", () => {
  const localSpacing = 3.5;
  const vistaSpacing = 14;
  const localBorderScale = (localSpacing / vistaSpacing) ** 2;
  const occupancy = 0.52;
  const localTreesPerSquareMeter = occupancy * localBorderScale / localSpacing ** 2;
  const vistaTreesPerSquareMeter = occupancy / vistaSpacing ** 2;
  assert.equal(localTreesPerSquareMeter, vistaTreesPerSquareMeter);
});

test("fades local grass density to zero at the vista border", () => {
  const sampleGrass = (x) => vegetationDensityScaleAcrossLocalBoundary(
    x,
    0,
    50,
    50,
    { innerScale: 1, borderScale: 0, outerScale: 0, transitionWidth: 16 },
  );
  assert.equal(sampleGrass(0), 1);
  assert.ok(sampleGrass(42) > 0 && sampleGrass(42) < 1);
  assert.equal(sampleGrass(50), 0);
});

test("premultiplies forced-low impostor samples before shared unpremultiplication", () => {
  const shaderSource = readFileSync(new URL("../src/TreeField.ts", import.meta.url), "utf8");
  assert.match(shaderSource, /lowColor\.a = step\(0\.5, lowColor\.a\)/);
  assert.match(shaderSource, /return vec4\(lowColor\.rgb \* lowColor\.a, lowColor\.a\)/);
});
