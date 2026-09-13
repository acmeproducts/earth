import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Exercise shaping without fetching or decoding provider rasters.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "lerc") return {
      url: "data:text/javascript,export function decode(){throw new Error('Unexpected decode')} export function load(){throw new Error('Unexpected load')}",
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/WorldCover.ts")) return {
      format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }),
    };
    return nextLoad(url, context);
  },
});

const { WorldCover } = await import("../src/WorldCover.ts");

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
