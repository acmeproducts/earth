import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("./ts-extension-resolver.mjs", import.meta.url);
const { conformTerrainToBuildings } = await import("../src/BuildingTerrain.ts");

function slopedTerrain() {
  const width = 13;
  const height = 13;
  const elevations = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      elevations[row * width + column] = 10 + column;
    }
  }
  return {
    elevations,
    minElevation: 10,
    maxElevation: 22,
    width,
    height,
    worldTile: { level: 16, x: 1, y: 1 },
    generationSeed: 1,
    groundWidthMeters: 12,
    groundHeightMeters: 12,
    bounds: { lonWest: 0, lonEast: 1, latNorth: 1, latSouth: 0 },
  };
}

const options = { meshWidth: 12, meshDepth: 12, metersPerUnit: 1 };
const footprint = {
  outline: [
    { x: -2, z: -2 },
    { x: 2, z: -2 },
    { x: 2, z: 2 },
    { x: -2, z: 2 },
    { x: -2, z: -2 },
  ],
};

test("levels a building footprint and a raster-safe foundation apron", async () => {
  const terrain = slopedTerrain();
  const modified = await conformTerrainToBuildings(terrain, [footprint], options);

  assert.ok(modified > 0);
  const foundationElevations = [];
  for (let row = 4; row <= 8; row++) {
    for (let column = 4; column <= 8; column++) {
      foundationElevations.push(terrain.elevations[row * terrain.width + column]);
    }
  }
  assert.equal(new Set(foundationElevations).size, 1);
  assert.equal(foundationElevations[0], 16);
});

test("blends the pad into the slope without changing distant terrain", async () => {
  const terrain = slopedTerrain();
  await conformTerrainToBuildings(terrain, [footprint], options);

  assert.equal(terrain.elevations[0], 10);
  assert.equal(terrain.elevations[terrain.elevations.length - 1], 22);
  assert.ok(terrain.elevations[6 * terrain.width + 2] > 12);
  assert.ok(terrain.elevations[6 * terrain.width + 2] < 16);
});
