import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const {
  providerElevationTileRange,
  providerPixelCrop,
} = await import("../src/terrain/TerrainElevationSource.ts");
const {
  createTerrainSkirtGeometry,
  stitchTerrainEdges,
  stitchTerrainMeshEdges,
} = await import("../src/terrain/TerrainStitching.ts");
const { worldTileBounds } = await import("../src/world/WorldGrid.ts");

const PROVIDER_LEVEL = 15;
const PROVIDER_TILE_SIZE = 256;
const game = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");

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

for (const level of [16, 17]) {
test(`uses shared elevation boundaries at a level-${level} four-tile corner`, () => {
  const northWest = elevationWindow({ level, x: 34_003, y: 40_003 });
  const northEast = elevationWindow({ level, x: 34_004, y: 40_003 });
  const southWest = elevationWindow({ level, x: 34_003, y: 40_004 });
  const southEast = elevationWindow({ level, x: 34_004, y: 40_004 });

  assert.equal(northWest.width, 256 / 2 ** (level - PROVIDER_LEVEL) + 1);
  assert.equal(northWest.height, northWest.width);
  assert.equal(northWest.east, northEast.west);
  assert.equal(southWest.east, southEast.west);
  assert.equal(northWest.south, southWest.north);
  assert.equal(northEast.south, southEast.north);

  const corner = `${northWest.east}/${northWest.south}`;
  assert.equal(`${northEast.west}/${northEast.south}`, corner);
  assert.equal(`${southWest.east}/${southWest.north}`, corner);
  assert.equal(`${southEast.west}/${southEast.north}`, corner);
});
}

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
  assert.ok(skirt.positions[2 * 3 + 1] < positions[1] - 0.02);
});

test("overlap strips stay beneath sloping terrain, including diagonal corners", () => {
  for (const slopeX of [3, 0, -3]) {
    for (const slopeZ of [-2, 0, 2]) {
      const subdivisions = 2;
      const positions = [];
      const uvs = [];
      const normals = [];
      const length = Math.hypot(slopeX, 1, slopeZ);
      const normal = [-slopeX / length, 1 / length, -slopeZ / length];
      const heightAt = (x, z) => 10 + slopeX * x + slopeZ * z;
      for (let row = 0; row <= subdivisions; row++) {
        for (let column = 0; column <= subdivisions; column++) {
          positions.push(column, heightAt(column, -row), -row);
          uvs.push(column, row);
          normals.push(...normal);
        }
      }
      const skirt = createTerrainSkirtGeometry(
        positions, uvs, subdivisions, -1, undefined, 0.5, 0.02, normals,
      );
      for (let segment = 0; segment < subdivisions * 4; segment++) {
        for (const offset of [0, 1, 2, 3, 4, 5]) {
          const vertex = (segment * 8 + offset) * 3;
          const [x, y, z] = skirt.positions.slice(vertex, vertex + 3);
          assert.ok(y <= heightAt(x, z) - 0.019,
            `overlap protrudes at (${x}, ${z}) on slope (${slopeX}, ${slopeZ})`);
          for (let axis = 0; axis < 3; axis++) {
            assert.ok(Math.abs(skirt.normals[vertex + axis] - normal[axis]) < 1e-6);
          }
        }
      }
    }
  }
});

test("skirt textures continue across every overlap and down vertical walls", () => {
  const positions = [];
  const uvs = [];
  for (let row = 0; row <= 2; row++) {
    for (let column = 0; column <= 2; column++) {
      positions.push(column * 2, 10, -row * 3);
      // Non-unit scale and reversed V catch assumptions about scene units.
      uvs.push(7 + column * 8, 30 - row * 12);
    }
  }
  for (const overlap of [0, 0.5]) {
    const skirt = createTerrainSkirtGeometry(positions, uvs, 2, 0, undefined, overlap);
    for (let segment = 0; segment < 8; segment++) {
      const base = segment * 8;
      for (let offset = 0; offset < 6; offset++) {
        const vertex = base + offset;
        assert.equal(skirt.uvs[vertex * 2], 7 + skirt.positions[vertex * 3] * 4);
        assert.equal(skirt.uvs[vertex * 2 + 1], 30 + skirt.positions[vertex * 3 + 2] * 4);
      }
      for (const bottom of [base + 6, base + 7]) {
        const top = bottom - 2;
        assert.equal(Math.hypot(
          skirt.uvs[bottom * 2] - skirt.uvs[top * 2],
          skirt.uvs[bottom * 2 + 1] - skirt.uvs[top * 2 + 1],
        ), 40);
      }
    }
  }
});

test("caches shared edges only after lake and map deformation", () => {
  const lakeStamp = game.indexOf("conformTerrainToLakePolygons(");
  const featureStamp = game.indexOf("OpenStreetMap.conformTerrainToPlan");
  const finalStitch = game.indexOf("stitchTerrainEdges(");
  assert.ok(lakeStamp >= 0);
  assert.ok(featureStamp > lakeStamp);
  assert.ok(finalStitch > featureStamp);
  assert.equal((game.match(/stitchTerrainEdges\(/g) ?? []).length, 1);
  assert.match(game, /sharedLakeElevations: this\.lakeElevations\.forOwner/);
});
