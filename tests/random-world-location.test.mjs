import assert from "node:assert/strict";
import test from "node:test";
import { randomWorldLocation } from "../src/Locations.ts";

test("generates deterministic locations within Web Mercator bounds", () => {
  const values = [0.25, 0.75];
  const location = randomWorldLocation(() => values.shift());

  assert.equal(location.lon, -90);
  assert.ok(location.lat > 0 && location.lat < 85.05112878);
});

test("samples the full supported longitude and latitude ranges", () => {
  const southWest = randomWorldLocation(() => 0);
  const nearNorthEast = randomWorldLocation(() => 1 - Number.EPSILON);

  assert.equal(southWest.lon, -180);
  assert.ok(Math.abs(southWest.lat + 85.05112878) < 1e-9);
  assert.ok(nearNorthEast.lon < 180);
  assert.ok(nearNorthEast.lat < 85.05112878);
});
