import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const treeSource = readFileSync(new URL("../src/vegetation/TreeField.ts", import.meta.url), "utf8");

test("the impostor vertex stage passes the per-axis instance scale to fragments", () => {
  // The proxy box and the atlas describe the unscaled source, while placement
  // gives every instance its own width and height scale.
  assert.match(treeSource, /varying vec3 vInstanceScale;/);
  assert.match(
    treeSource,
    /vInstanceScale = max\(vec3\(\s*length\(finalWorld\[0\]\.xyz\),\s*length\(finalWorld\[1\]\.xyz\),\s*length\(finalWorld\[2\]\.xyz\)\s*\), vec3\(0\.0001\)\);/,
  );
});

test("the per-fragment view ray meets the image plane in local units", () => {
  // Mixing the world-length camera offset with unscaled vertex positions made
  // the projected image drift away from the model on every scaled instance.
  assert.match(treeSource, /vec3 localCameraOffset = vViewDirection \/ vInstanceScale;/);
  assert.match(treeSource, /vec3 direction = normalize\(localCameraOffset\);/);
  assert.match(treeSource, /vec3 cameraOffset = localCameraOffset;\s*vec3 ray = vLocalPosition - cameraOffset;/);
  assert.doesNotMatch(treeSource, /vec3 cameraOffset = vViewDirection;/);
});

test("the ellipsoid depth proxy converts its local hit back to world depth", () => {
  assert.match(treeSource, /vec3 towardFragment = vLocalPosition - localCameraOffset;/);
  assert.match(treeSource, /vec3 scaledOrigin = localCameraOffset \/ proxyRadii;/);
  assert.match(
    treeSource,
    /float depthOffset = dot\(localHit \* vInstanceScale, normalize\(vViewDirection\)\);/,
  );
});

test("fog and distance fades still measure world distance", () => {
  assert.match(treeSource, /float fog = smoothstep\(fogStart, fogEnd, length\(vViewDirection\)\);/);
  const dropoutSource = readFileSync(new URL("../src/vegetation/DistanceDropout.ts", import.meta.url), "utf8");
  assert.match(dropoutSource, /distanceFadeFar,\s*length\(cameraPosition - instanceOrigin\)/);
  assert.match(treeSource, /distanceDropoutScale\(instanceOrigin, cameraPosition, vDistanceFade\)/);
});

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (v) => {
  const length = Math.hypot(...v);
  return v.map((component) => component / length);
};

/** Mirrors the fragment shader: ray from the camera through the box vertex onto the center plane. */
function projectOntoCenterPlane(cameraOffset, localVertex) {
  const direction = normalize(cameraOffset);
  const ray = localVertex.map((v, i) => v - cameraOffset[i]);
  const t = -dot(cameraOffset, direction) / dot(ray, direction);
  return cameraOffset.map((v, i) => v + ray[i] * t);
}

test("a scaled instance's trunk base lands where the atlas drew it", () => {
  // A unit source scaled 0.8 wide and 1.3 tall, seen from 6 units in front
  // and 2 units up. The fragment covering the trunk base is the box's front
  // face where the world ray from the camera through the base crosses it.
  const scale = [0.8, 1.3, 0.8];
  const camera = [0, 2, 6];
  const base = [0, -0.5, 0];
  const worldBase = base.map((v, i) => v * scale[i]);
  const u = (0.5 * scale[2] - camera[2]) / (worldBase[2] - camera[2]);
  const worldVertex = camera.map((v, i) => v + (worldBase[i] - v) * u);
  const localVertex = worldVertex.map((v, i) => v / scale[i]);
  assert.ok(Math.abs(localVertex[1]) <= 0.5, "the ray must hit inside the proxy box");

  // Scaling is affine, so in local units that same ray still runs from the
  // local camera through the base. The impostor must sample the image where
  // that ray crosses the plane through the center, exactly as it does for an
  // unscaled instance.
  const localCamera = camera.map((v, i) => v / scale[i]);
  const localDirection = normalize(localCamera);
  const toBase = base.map((v, i) => v - localCamera[i]);
  const t = -dot(localCamera, localDirection) / dot(toBase, localDirection);
  const expected = localCamera.map((v, i) => v + toBase[i] * t);

  const fixed = projectOntoCenterPlane(localCamera, localVertex);
  const old = projectOntoCenterPlane(camera, localVertex);
  const error = (hit) => Math.hypot(...hit.map((v, i) => v - expected[i]));
  assert.ok(error(fixed) < 1e-9, `fixed path off by ${error(fixed)}`);
  // The old path shifts a 1.3-tall source's base by a visible fraction of it.
  assert.ok(error(old) > 0.05, `old path only off by ${error(old)}`);
});

test("an unscaled instance projects exactly as before", () => {
  const camera = [1, 2, 6];
  const localVertex = [0.3, -0.2, 0.5];
  const fixed = projectOntoCenterPlane(camera.map((v) => v / 1), localVertex);
  const old = projectOntoCenterPlane(camera, localVertex);
  assert.deepEqual(fixed, old);
});
