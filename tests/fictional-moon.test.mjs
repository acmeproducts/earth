import assert from "node:assert/strict";
import test from "node:test";

const {
  fictionalMoonPhase,
  fictionalMoonSkyVisibility,
  FICTIONAL_MOON_PHASE_EPOCH,
} = await import("../src/FictionalMoon.ts");

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const atDay = (day) => new Date(FICTIONAL_MOON_PHASE_EPOCH + day * DAY_MILLISECONDS);

test("fictional moon cycles through full, quarters, and new over six days", () => {
  assert.equal(fictionalMoonPhase(atDay(0)), 0);
  assert.equal(fictionalMoonPhase(atDay(1.5)), 0.25);
  assert.equal(fictionalMoonPhase(atDay(3)), 0.5);
  assert.equal(fictionalMoonPhase(atDay(4.5)), 0.75);
  assert.equal(fictionalMoonPhase(atDay(6)), 0);
});

test("fictional phase wraps correctly before its epoch", () => {
  assert.equal(fictionalMoonPhase(atDay(-1.5)), 0.75);
});

test("moon remains strongest at night but visible by day", () => {
  assert.equal(fictionalMoonSkyVisibility(-10), 1);
  assert.equal(fictionalMoonSkyVisibility(30), 0.28);
  assert.ok(fictionalMoonSkyVisibility(5) < 1);
  assert.ok(fictionalMoonSkyVisibility(5) > 0.28);
});
