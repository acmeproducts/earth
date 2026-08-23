import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  providerElevationTileRange,
  providerPixelCrop,
} from "../src/TerrainElevationSource.ts";
import {
  createTerrainSkirtGeometry,
  stitchTerrainEdges,
  stitchTerrainMeshEdges,
} from "../src/TerrainStitching.ts";
import { worldTileBounds } from "../src/WorldGrid.ts";

const PROVIDER_LEVEL = 15;
const PROVIDER_TILE_SIZE = 256;
const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");

function elevationWindow(tile) {
  const bounds = worldTileBounds(tile);
  const range = providerElevationTileRange(bounds, PROVIDER_LEVEL);
  const columns = range.southEast.x - range.northWest.x + 1;
  const rows = range.southEast.y - range.northWest.y + 1;
  const crop = providerPixelCrop(
    bounds,
    PROVIDER_LEVEL,
    range.northWest,
    PROVIDER_TILE_SIZE,
    columns * PROVIDER_TILE_SIZE,
    rows * PROVIDER_TILE_SIZE,
  );
  const west = range.northWest.x * PROVIDER_TILE_SIZE + crop.left;
  const north = range.northWest.y * PROVIDER_TILE_SIZE + crop.top;
  return {
    west,
    east: west + crop.width - 1,
    north,
    south: north + crop.height - 1,
    width: crop.width,
    height: crop.height,
  };
}

test("uses one shared elevation row and column at a four-tile corner", () => {
  const northWest = elevationWindow({ level: 16, x: 34_000, y: 20_000 });
  const northEast = elevationWindow({ level: 16, x: 34_001, y: 20_000 });
  const southWest = elevationWindow({ level: 16, x: 34_000, y: 20_001 });
  const southEast = elevationWindow({ level: 16, x: 34_001, y: 20_001 });

  assert.equal(northWest.width, 129);
  assert.equal(northWest.height, 129);
  assert.equal(northWest.east, northEast.west);
  assert.equal(southWest.east, southEast.west);
  assert.equal(northWest.south, southWest.north);
  assert.equal(northEast.south, southEast.north);

  const corner = `${northWest.east}/${northWest.south}`;
  assert.equal(`${northEast.west}/${northEast.south}`, corner);
  assert.equal(`${southWest.east}/${southWest.north}`, corner);
  assert.equal(`${southEast.west}/${southEast.north}`, corner);
});

test("builds one terrain cell between each pair of elevation samples", () => {
  assert.match(
    game,
    /native\s*\? terrainData\.width - 1\s*: Math\.min\(FAR_TILE_SUBDIVISIONS, terrainData\.width - 1\)/,
  );
});

function terrain(tileX, tileY, fill) {
  const width = 5;
  const height = 5;
  return {
    elevations: new Float32Array(width * height).fill(fill),
    minElevation: fill,
    maxElevation: fill,
    width,
    height,
    worldTile: { level: 16, x: tileX, y: tileY },
    generationSeed: 1,
    groundWidthMeters: 1,
    groundHeightMeters: 1,
    bounds: { lonWest: 0, lonEast: 1, latNorth: 1, latSouth: 0 },
  };
}

test("reuses final processed heights along edges and at four-way corners", () => {
  const cache = new Map();
  const northWest = terrain(10, 20, 10);
  const northEast = terrain(11, 20, 20);
  const southWest = terrain(10, 21, 30);
  const southEast = terrain(11, 21, 40);

  for (const tile of [northWest, northEast, southWest, southEast]) {
    stitchTerrainEdges(tile, cache);
  }

  for (let index = 0; index < 5; index++) {
    assert.equal(northWest.elevations[index * 5 + 4], northEast.elevations[index * 5]);
    assert.equal(northWest.elevations[20 + index], southWest.elevations[index]);
  }
  const corner = northWest.elevations[24];
  assert.equal(northEast.elevations[20], corner);
  assert.equal(southWest.elevations[4], corner);
  assert.equal(southEast.elevations[0], corner);
});

test("makes detailed edges follow the same profile as coarse edges", () => {
  const subdivisions = 128;
  const verticesPerRow = subdivisions + 1;
  const positions = new Float32Array(verticesPerRow * verticesPerRow * 3);
  for (let row = 0; row <= subdivisions; row++) {
    for (let column = 0; column <= subdivisions; column++) {
      positions[(row * verticesPerRow + column) * 3 + 1] = column * column + row * row;
    }
  }

  stitchTerrainMeshEdges(positions, subdivisions, 32);

  for (let vertex = 0; vertex <= 128; vertex++) {
    const segment = Math.floor(vertex / 4);
    const start = Math.min(128, segment * 4);
    const end = Math.min(128, start + 4);
    const amount = (vertex - start) / Math.max(1, end - start);
    const coarseProfile = start * start + (end * end - start * start) * amount;
    assert.equal(positions[vertex * 3 + 1], coarseProfile);
  }
  assert.equal(positions[(64 * verticesPerRow + 64) * 3 + 1], 64 * 64 * 2);
});

test("builds a double-sided skirt below every terrain edge segment", () => {
  const subdivisions = 2;
  const rowSize = subdivisions + 1;
  const positions = new Float32Array(rowSize * rowSize * 3);
  const uvs = new Float32Array(rowSize * rowSize * 2);
  const colors = new Float32Array(rowSize * rowSize * 4).fill(0.5);
  for (let row = 0; row < rowSize; row++) {
    for (let column = 0; column < rowSize; column++) {
      const vertex = row * rowSize + column;
      positions.set([column, 10 + vertex, -row], vertex * 3);
      uvs.set([column, row], vertex * 2);
    }
  }

  const skirt = createTerrainSkirtGeometry(
    positions,
    uvs,
    subdivisions,
    -1,
    colors,
    0.5,
    0.02,
  );
  assert.equal(skirt.positions.length / 3, subdivisions * 4 * 8);
  assert.equal(skirt.indices.length, subdivisions * 4 * 24);
  assert.equal(skirt.colors.length / 4, skirt.positions.length / 3);
  for (let vertex = 6; vertex < skirt.positions.length / 3; vertex += 8) {
    assert.equal(skirt.positions[vertex * 3 + 1], -1);
    assert.equal(skirt.positions[(vertex + 1) * 3 + 1], -1);
  }
  // The north-west outer corner is shared by the first and last segments.
  // Both must reach the diagonal corner of the overlap instead of leaving a
  // square hole between their independently extruded strips.
  assert.equal(skirt.positions[2 * 3], -0.5);
  assert.equal(skirt.positions[2 * 3 + 2], 0.5);
  const lastSegmentOuterEnd = skirt.positions.length / 3 - 1;
  assert.equal(skirt.positions[lastSegmentOuterEnd * 3], -0.5);
  assert.equal(skirt.positions[lastSegmentOuterEnd * 3 + 2], 0.5);
  assert.ok(Math.abs(skirt.positions[2 * 3 + 1] - (positions[1] - 0.02)) < 1e-5);
});

test("restitches detailed terrain after map-driven deformation", () => {
  const initialStitch = game.indexOf("stitchTerrainEdges(terrainData");
  const buildingStamp = game.indexOf("OpenStreetMap.conformTerrainToBuildings");
  const finalStitch = game.indexOf("stitchTerrainEdges(terrainData", initialStitch + 1);
  assert.ok(initialStitch >= 0);
  assert.ok(buildingStamp > initialStitch);
  assert.ok(finalStitch > buildingStamp);
});
