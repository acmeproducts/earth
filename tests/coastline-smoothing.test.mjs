import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { shapeCoastlineElevations } from "../src/Coastline.ts";

function terrain(elevations) {
  return {
    elevations: new Float32Array(elevations),
    minElevation: Math.min(...elevations),
    maxElevation: Math.max(...elevations),
    width: elevations.length,
    height: 1,
  };
}

test("shoreline follows fractional coverage instead of snapping to cell midpoints", async () => {
  const run = async (offset) => {
    const coverage = Float32Array.from({ length: 9 }, (_, x) => 0.5 + (x - 4 + offset) * 0.08);
    const grid = terrain(Array(9).fill(8));
    await shapeCoastlineElevations(grid, {
      coverage, water: Uint8Array.from(coverage, value => Number(value >= 0.5)),
      width: 9, height: 1,
    }, {
      metersPerPixelX: 10, metersPerPixelY: 10,
      landBlendWidthMeters: 80, waterBlendWidthMeters: 160,
      deepWaterCeilingMeters: -50,
    });
    return grid;
  };
  const before = await run(-0.01);
  const after = await run(0.01);
  assert.ok(before.elevations[4] > 0);
  assert.ok(after.elevations[4] < 0);
  assert.ok(Math.abs(before.elevations[4] - after.elevations[4]) < 0.03,
    "crossing the threshold must not introduce a shallow-water depth jump");
  assert.ok(Math.abs(before.shoreDistanceMeters[4] - 0.1) < 1e-4);
  assert.ok(Math.abs(after.shoreDistanceMeters[4] + 0.1) < 1e-4);
});

test("builds a shallow shelf instead of a cliff at the waterline", async () => {
  const grid = terrain([12, 12, 12, 12, 0, 0, 0, 0, 0]);
  const water = new Uint8Array([0, 0, 0, 0, 1, 1, 1, 1, 1]);
  const coverage = new Float32Array([0, 0, 0.1, 0.4, 0.6, 0.9, 1, 1, 1]);

  await shapeCoastlineElevations(grid, {
    coverage,
    water,
    width: coverage.length,
    height: 1,
  }, {
    metersPerPixelX: 10,
    metersPerPixelY: 10,
    landBlendWidthMeters: 80,
    waterBlendWidthMeters: 160,
    deepWaterCeilingMeters: -50,
  });

  assert.ok(grid.elevations[3] > 0);
  assert.ok(grid.elevations[4] < 0);
  assert.ok(grid.elevations[4] > -3);
  assert.ok(grid.elevations[3] - grid.elevations[4] < 4);
  assert.equal(grid.minElevation, Math.min(...grid.elevations));
  assert.equal(grid.maxElevation, Math.max(...grid.elevations));
});

test("keeps terrain unchanged once it is beyond the coastal blend", async () => {
  const elevations = Array(41).fill(0);
  elevations.fill(12, 0, 20);
  const grid = terrain(elevations);
  const water = new Uint8Array(41);
  water.fill(1, 20);
  const coverage = new Float32Array(41);
  coverage.fill(1, 20);

  await shapeCoastlineElevations(grid, {
    coverage,
    water,
    width: coverage.length,
    height: 1,
  }, {
    metersPerPixelX: 10,
    metersPerPixelY: 10,
    landBlendWidthMeters: 80,
    waterBlendWidthMeters: 160,
    deepWaterCeilingMeters: -50,
  });

  assert.equal(grid.elevations[0], 12);
  assert.equal(grid.elevations.at(-1), -50);
});

test("uses shoreline context beyond the terrain tile edge", async () => {
  const grid = terrain([0, 0, 0, 0, 0]);
  const coverage = new Float32Array([0, 0.2, 0.8, 1, 1, 1, 1, 1, 1]);
  const water = new Uint8Array([0, 0, 1, 1, 1, 1, 1, 1, 1]);

  await shapeCoastlineElevations(grid, {
    coverage,
    water,
    width: coverage.length,
    height: 1,
    terrainOffsetX: 3,
  }, {
    metersPerPixelX: 10,
    metersPerPixelY: 10,
    landBlendWidthMeters: 80,
    waterBlendWidthMeters: 160,
    deepWaterCeilingMeters: -50,
  });

  assert.ok(grid.elevations[0] > -4, "the off-tile shore should keep the edge shallow");
  assert.ok(grid.elevations.at(-1) > -30, "the shelf should continue smoothly into the tile");
});

test("preserves the carved profile during terrain interpolation", () => {
  const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");
  const terrainMesh = readFileSync(
    new URL("../src/TerrainMesh.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    terrainMesh,
    /const elevation = terrain\.waterMask\s*\? interpolatedElevation\s*:\s*sinkSubmergedElevation\(interpolatedElevation\)/,
  );
  assert.match(
    game,
    /if \(landCover\)[\s\S]*await landCover\.constrainElevations[\s\S]*else \{\s*sinkSubmergedTerrain\(terrainData\)/,
  );
  assert.match(game, /WorldCover\.fetchForTerrain\(terrainData\)/);
});
