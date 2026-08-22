import assert from "node:assert/strict";
import test from "node:test";
import { randomLandWorldLocation, randomWorldLocation } from "../src/Locations.ts";

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

test("retries random locations until the classifier finds land", async () => {
  const values = [0.25, 0.5, 0.75, 0.5];
  const checkedLongitudes = [];
  const location = await randomLandWorldLocation((candidate) => {
    checkedLongitudes.push(candidate.lon);
    return candidate.lon > 0;
  }, () => values.shift());

  assert.deepEqual(checkedLongitudes, [-90, 90]);
  assert.equal(location.lon, 90);
  assert.equal(location.lat, 0);
});

test("fails rather than returning water when no land is found", async () => {
  await assert.rejects(
    randomLandWorldLocation(() => false, () => 0.5, 2),
    /Could not find a land location after 2 attempts/,
  );
});
