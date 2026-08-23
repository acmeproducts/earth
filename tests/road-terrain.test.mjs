import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("./ts-extension-resolver.mjs", import.meta.url);
const { conformTerrainToRoads } = await import("../src/RoadTerrain.ts");

function slopedTerrain() {
  const width = 9;
  const height = 9;
  const elevations = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      elevations[row * width + column] = column * 2;
    }
  }
  return {
    elevations,
    minElevation: 0,
    maxElevation: 16,
    width,
    height,
    worldTile: { level: 16, x: 1, y: 1 },
    generationSeed: 1,
    groundWidthMeters: 8,
    groundHeightMeters: 8,
    bounds: { lonWest: 0, lonEast: 1, latNorth: 1, latSouth: 0 },
  };
}

const options = { meshWidth: 8, meshDepth: 8, metersPerUnit: 1 };
const points = [{ x: 0, z: -4 }, { x: 0, z: 4 }];

test("flattens the carriageway and blends its shoulder into cross slope", async () => {
  const terrain = slopedTerrain();
  const modified = await conformTerrainToRoads(terrain, [{
    points,
    widthMeters: 2,
    shoulderWidthMeters: 2,
    structure: "surface",
  }], options);

  assert.ok(modified > 0);
  assert.equal(terrain.elevations[4 * 9 + 3], 8);
  assert.equal(terrain.elevations[4 * 9 + 5], 8);
  assert.ok(terrain.elevations[4 * 9 + 2] > 4);
  assert.ok(terrain.elevations[4 * 9 + 2] < 8);
  assert.equal(terrain.elevations[4 * 9], 0);
});

test("does not carve terrain beneath a bridge", async () => {
  const terrain = slopedTerrain();
  const original = terrain.elevations.slice();
  const modified = await conformTerrainToRoads(terrain, [{
    points,
    widthMeters: 8,
    shoulderWidthMeters: 2,
    structure: "bridge",
  }], options);

  assert.equal(modified, 0);
  assert.deepEqual(terrain.elevations, original);
});
