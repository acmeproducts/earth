import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { randomLandWorldLocation } from "../src/world/Locations.ts";

// Exercise shaping without fetching or decoding provider rasters.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/WorldCover.ts")) return {
      format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }),
    };
    return nextLoad(url, context);
  },
});

const { WorldCover } = await import("../src/world/WorldCover.ts");

test("random navigation rejects missing, masked and water pixels before accepting land", async () => {
  const pixels = new Uint8Array(240 * 240).fill(80);
  const mask = new Uint8Array(pixels.length).fill(1);
  pixels[120 * 240 + 122] = 10;
  mask[120 * 240 + 120] = 0;
  const cover = new WorldCover(new Map([["1204/9536", { width: 240, pixels: [pixels], mask }]]));
  const lat = 84 - (1204 * 240 + 120.5) / 12_000;
  const positions = [
    { lat: -47.59, lon: 35.27 },
    ...[120.5, 121.5, 122.5].map(x => ({ lat, lon: -180 + (9536 * 240 + x) / 12_000 })),
  ];
  const values = positions.flatMap(p => [
    (p.lon + 180) / 360,
    (Math.sin(p.lat * Math.PI / 180) / Math.sin(85.05112878 * Math.PI / 180) + 1) / 2,
  ]);
  let attempts = 0;
  const destination = await randomLandWorldLocation(location => {
    attempts++;
    const classification = cover.sampleKnown(location.lon, location.lat);
    return classification !== undefined && classification !== 80;
  }, () => values.shift(), 4);
  assert.equal(attempts, 4);
  assert.ok(Math.abs(destination.lon - positions[3].lon) < 1e-8);
  assert.equal(cover.sampleKnown(35.27, -47.59), undefined);
  assert.equal(cover.sample(35.27, -47.59), 60, 'visual fallback remains separate from navigation');
});

test("LCM-10 raster boundaries use their 240-pixel grid for sampling and water", () => {
  const land = { width: 240, pixels: [new Uint8Array(240 * 240).fill(10)] };
  const water = { width: 240, pixels: [new Uint8Array(240 * 240).fill(80)] };
  const cover = new WorldCover(new Map([["1204/9536", land], ["1204/9537", water]]), 1 / 12_000, 240);
  const latitude = 84 - (1204 * 240 + 120.5) / 12_000;
  const longitude = -180 + 9537 * 240 / 12_000;
  assert.equal(cover.sample(longitude - 0.5 / 12_000, latitude), 10);
  assert.equal(cover.sample(longitude + 0.5 / 12_000, latitude), 80);
  assert.ok(Math.abs(cover.waterCoverage(longitude, latitude) - 0.5) < 1e-6);
});

function terrain() {
  return {
    width: 9, height: 9,
    groundWidthMeters: 80, groundHeightMeters: 80,
    bounds: { lonWest: 0, lonEast: 0.001, latNorth: 0.001, latSouth: 0 },
    elevations: Float32Array.from({ length: 81 }, (_, i) => (i - 10) * 0.125),
    minElevation: -999, maxElevation: 999,
    waterMask: new Uint8Array(81).fill(1),
    shoreDistanceMeters: new Float32Array(81).fill(-10),
  };
}

async function shape(waterCoverage) {
  const cover = new WorldCover(new Map(), 1 / 12_000);
  cover.waterCoverage = waterCoverage;
  const grid = terrain();
  let yields = 0;
  await cover.constrainElevations(grid, undefined, undefined, async () => { yields++; });
  return { grid, yields };
}

test("dry context matches the full no-shore pipeline and skips its work", async () => {
  const dry = await shape(() => 0);
  // Uniform fractional coverage takes the full pipeline, but still has no
  // classified water, gradients or shoreline. Its outputs must match exactly.
  const reference = await shape(() => 0.25);
  assert.deepEqual(dry.grid, reference.grid);
  assert.deepEqual(dry.grid.elevations, terrain().elevations.map(value => Math.max(0.25, value)));
  assert.deepEqual(dry.grid.waterMask, new Uint8Array(81));
  assert.deepEqual(dry.grid.shoreDistanceMeters, new Float32Array(81).fill(1e6));
  assert.equal(dry.grid.minElevation, 0.25);
  assert.equal(dry.grid.maxElevation, 8.75);
  assert.ok(dry.yields < reference.yields / 2, "dry tiles should skip smoothing and distance passes");
});

test("water outside the tile still shapes its dry edge", async () => {
  const { grid } = await shape(longitude => longitude < 0 ? 1 : 0);
  assert.ok(grid.shoreDistanceMeters.some(distance => distance > 0 && distance < 80));
  assert.ok(grid.elevations.some((value, i) =>
    terrain().elevations[i] > 0.25 && value < terrain().elevations[i]));
});

test("all-water context keeps submerged constraints and signed distances", async () => {
  const { grid } = await shape(() => 1);
  assert.deepEqual(grid.waterMask, new Uint8Array(81).fill(1));
  assert.deepEqual(grid.shoreDistanceMeters, new Float32Array(81).fill(-1e6));
  assert.ok(grid.elevations.every(value => value < 0));
  assert.equal(grid.minElevation, grid.maxElevation);
});
