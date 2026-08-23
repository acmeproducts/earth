import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("./ts-extension-resolver.mjs", import.meta.url);
const { clamp, clamp01, smoothstep } = await import("../src/MathUtils.ts");

test("shared numeric helpers preserve normalized arithmetic", () => {
  assert.equal(clamp(-2, -1, 3), -1);
  assert.equal(clamp(4, -1, 3), 3);
  assert.equal(clamp01(-0.5), 0);
  assert.equal(clamp01(1.5), 1);
});

test("smoothstep clamps its input and eases within the edge range", () => {
  assert.equal(smoothstep(2, 4, 1), 0);
  assert.equal(smoothstep(2, 4, 3), 0.5);
  assert.equal(smoothstep(2, 4, 5), 1);
});
