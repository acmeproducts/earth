import assert from "node:assert/strict";
import test from "node:test";

const {
  starTwinkleProfile,
  TWINKLE_HORIZON_PROBABILITY,
  TWINKLE_HORIZON_STRENGTH,
  TWINKLE_ZENITH_PROBABILITY,
  TWINKLE_ZENITH_STRENGTH,
} = await import("../src/sky/StarTwinkle.ts");

test("stars flicker more often and more strongly toward the horizon", () => {
  const horizon = starTwinkleProfile(0);
  const middleSky = starTwinkleProfile(Math.sin(Math.PI / 4));
  const zenith = starTwinkleProfile(1);

  assert.equal(horizon.eventProbability, TWINKLE_HORIZON_PROBABILITY);
  assert.equal(horizon.eventStrength, TWINKLE_HORIZON_STRENGTH);
  assert.ok(middleSky.eventProbability < horizon.eventProbability);
  assert.ok(middleSky.eventProbability > zenith.eventProbability);
  assert.ok(middleSky.eventStrength < horizon.eventStrength);
  assert.ok(middleSky.eventStrength > zenith.eventStrength);
  assert.equal(zenith.eventProbability, TWINKLE_ZENITH_PROBABILITY);
  assert.equal(zenith.eventStrength, TWINKLE_ZENITH_STRENGTH);
});

test("twinkle altitude clamps below the horizon and above the zenith", () => {
  assert.deepEqual(starTwinkleProfile(-1), starTwinkleProfile(0));
  assert.deepEqual(starTwinkleProfile(2), starTwinkleProfile(1));
});
