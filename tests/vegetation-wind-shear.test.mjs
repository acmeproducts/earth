import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

const add = (a, b) => a.map((value, index) => value + b[index]);
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const scale = (a, factor) => a.map((value) => value * factor);
const close = (a, b, message) => {
  a.forEach((value, index) => {
    assert.ok(
      Math.abs(value - b[index]) < 1e-12,
      `${message}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
    );
  });
};

// The gradient the shader multiplies by height above the base.
const GRADIENT = [0.13, 0, -0.062];

test("the warp anchors to the subject, not to the oversized proxy box", () => {
  // Grass sits inside a square capture more than four times its own height, so
  // a warp driven by the box would displace the image several times too far.
  // Displacing the projected sample point instead keys the lean to capture
  // height, which is what the atlas frame actually measures.
  const modelHeight = 1;
  const captureCenterY = modelHeight / 2;
  const boxHalfHeight = 4.47 * modelHeight / 2;
  const lean = Math.hypot(GRADIENT[0], GRADIENT[2]);

  // Side on, the projection plane is vertical: capture height survives it, so
  // the frame shears progressively and the tip leans by exactly its own height.
  for (const captureHeight of [0, 0.5, 1]) {
    const projected = [0, captureHeight - captureCenterY, 0];
    const displaced = subtract(
      projected,
      scale(GRADIENT, projected[1] + captureCenterY),
    );
    const shifted = Math.hypot(displaced[0] - projected[0], displaced[2] - projected[2]);
    assert.ok(
      Math.abs(shifted - lean * captureHeight) < 1e-12,
      `side-on lean at height ${captureHeight}: ${shifted}`,
    );
  }

  // From overhead the plane is level, so the frame shifts by one amount: the
  // lean at mid-height. Never by the lean at the far taller box roof.
  const overhead = [0.3, 0, -0.2];
  const overheadDisplaced = subtract(
    overhead,
    scale(GRADIENT, overhead[1] + captureCenterY),
  );
  const overheadShift = Math.hypot(
    overheadDisplaced[0] - overhead[0],
    overheadDisplaced[2] - overhead[2],
  );
  assert.ok(
    Math.abs(overheadShift - lean * captureCenterY) < 1e-12,
    `overhead shift should be the mid-height lean: ${overheadShift}`,
  );
  assert.ok(
    overheadShift < lean * (captureCenterY + boxHalfHeight) * 0.25,
    "overhead shift must not scale with the proxy box",
  );
});

test("grass and bushes lean by a shear", () => {
  const wind = source("Wind.ts");
  assert.match(wind, /const SHEAR_FRACTIONS = \{ grass: [\d.]+, bush: [\d.]+ \}/);
  assert.match(wind, /return windShearGradient\(localDirection, bend\) \* \(localPosition\.y - baseY\)/);
  // Nothing about the shear is captured, so it can follow one world direction.
  assert.match(wind, /vec2 windLocalDirection\(vec3 axisX, vec3 axisZ\)/);
  for (const field of ["GrassField.ts", "BushField.ts"]) {
    assert.match(source(field), /setVegetationWindShear\(/);
    assert.match(source(field), /windShearFraction\("(grass|bush)"\)/);
  }
});

test("the impostor and the live model lean by the same amount", () => {
  const impostor = source("TreeField.ts");
  const model = source("ProceduralCaptureMaterial.ts");
  // The impostor warps its lookup; the model moves real vertices. Both are the
  // same gradient times height above the base, so they agree across the LOD.
  assert.match(impostor, /vWindShear = windShearGradient\(/);
  assert.match(
    impostor,
    /projectedPosition -= vWindShear \* \(projectedPosition\.y \+ captureCenterY\)/,
  );
  assert.match(model, /windShearOffset\(\s*position,\s*0\.0,/);
  // The proxy box itself must not move, or the warp would be applied twice.
  assert.doesNotMatch(impostor, /vec4\(position \+ /);
  // The capture must stay upright, or the lean would be baked in as well.
  assert.match(model, /setWindShear\(material, 0\)/);
});

test("shadows remain cached because wind does not affect tree casters", () => {
  const lighting = source("SolarLighting.ts");
  assert.doesNotMatch(lighting, /SHADOW_REFRESH_FRAMES|shadow-refresh|vegetation shadows sway/);
  assert.match(lighting, /RenderTargetTexture\.REFRESHRATE_RENDER_ONCE/);
});
