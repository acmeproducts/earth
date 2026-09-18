import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { hasWinterGroundCover, snowCoverAt, snowCoverTier, snowCoverForTier, SNOW_COVER_TIERS } =
  await import("../src/vegetation/TreeSeason.ts");

test("winter ground cover follows the hemisphere", () => {
  assert.equal(hasWinterGroundCover(new Date(2026, 0, 15), 60), true);
  assert.equal(hasWinterGroundCover(new Date(2026, 0, 15), -60), false);
  assert.equal(hasWinterGroundCover(new Date(2026, 6, 15), 60), false);
  assert.equal(hasWinterGroundCover(new Date(2026, 6, 15), -60), true);
});

test("tropical and invalid locations do not receive seasonal snow", () => {
  assert.equal(hasWinterGroundCover(new Date(2026, 0, 15), 10), false);
  assert.equal(hasWinterGroundCover(undefined, 60), false);
  assert.equal(hasWinterGroundCover(new Date(Number.NaN), 60), false);
  assert.equal(snowCoverAt(new Date(2026, 0, 15), 10), 0);
  assert.equal(snowCoverAt(new Date(2026, 6, 15), 60), 0);
});

test("snow depth builds through winter and grows with latitude and elevation", () => {
  const earlyWinter = snowCoverAt(new Date(2026, 11, 1), 60);
  const midWinter = snowCoverAt(new Date(2026, 0, 20), 60);
  const lateWinter = snowCoverAt(new Date(2026, 1, 27), 60);
  assert.ok(earlyWinter > 0 && earlyWinter < midWinter, `${earlyWinter} < ${midWinter}`);
  assert.ok(lateWinter > 0 && lateWinter < midWinter, `${lateWinter} < ${midWinter}`);
  assert.ok(midWinter <= 1);

  assert.ok(snowCoverAt(new Date(2026, 0, 20), 30) < snowCoverAt(new Date(2026, 0, 20), 60));
  assert.ok(snowCoverAt(new Date(2026, 0, 20), 30, 0) < snowCoverAt(new Date(2026, 0, 20), 30, 1500));
  assert.ok(snowCoverAt(new Date(2026, 0, 20), 60, 5000) <= 1);
  // Southern winter mirrors the northern one.
  assert.equal(snowCoverAt(new Date(2026, 6, 20), -60), snowCoverAt(new Date(2026, 0, 20), 60));
});

test("snow tiers quantize depth and round-trip to a shared baked depth", () => {
  assert.equal(snowCoverTier(0), 0);
  assert.equal(snowCoverTier(0.05), 1);
  assert.equal(snowCoverTier(1), SNOW_COVER_TIERS);
  for (let tier = 1; tier <= SNOW_COVER_TIERS; tier++) {
    assert.equal(snowCoverTier(snowCoverForTier(tier)), tier);
  }
  assert.equal(snowCoverForTier(0), 0);
});

test("California lowlands stay bare throughout winter while Sierra elevations get snow", () => {
  const lowlands = [
    [32.72, -117.16, 20], // San Diego
    [34.05, -118.24, 90], // Los Angeles
    [37.77, -122.42, 50], // San Francisco
    [38.58, -121.49, 10], // Sacramento
    [40.59, -122.39, 170], // Redding
  ];
  for (const month of [11, 0, 1]) {
    const date = new Date(2026, month, 20);
    for (const [latitude, longitude, elevation] of lowlands) {
      assert.equal(snowCoverAt(date, latitude, elevation, longitude), 0);
      assert.equal(hasWinterGroundCover(date, latitude, elevation, longitude), false);
    }
    assert.ok(snowCoverAt(date, 39.17, 1900, -120.14) > 0);
    assert.ok(snowCoverAt(date, 37.65, 3000, -119.03) > 0);
  }
  assert.equal(snowCoverAt(new Date(2026, 6, 20), 39.17, 1900, -120.14), 0);
});

test("regional mild climates raise the snow line without removing northern snow", () => {
  const date = new Date(2026, 0, 20);
  assert.ok(snowCoverAt(date, 39, 1200, -105) > 0);
  assert.equal(snowCoverAt(date, 39, 1200, -121), 0);
  assert.ok(snowCoverAt(date, 60, 0, 10.75) > 0);
});

test("winter no longer removes seasonal low vegetation; tiles pass their snow depth instead", async () => {
  const game = await readFile(new URL("../src/app/Game.ts", import.meta.url), "utf8");
  assert.doesNotMatch(game, /winterGroundCover/);
  assert.match(game, /seasonalDate: this\.vegetationDate,\s*snowCover: this\.tileSnowCover\(terrainData\),/);
});
