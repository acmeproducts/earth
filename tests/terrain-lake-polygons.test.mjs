import assert from "node:assert/strict";
import test from "node:test";

const { buildTerrainLakePolygons } = await import("../src/TerrainLakePolygons.ts");

function terrain(mask, elevations = mask.map((water) => water ? 40 : 50)) {
  return {
    elevations: new Float32Array(mask.length),
    minElevation: -50,
    maxElevation: 50,
    width: 5,
    height: 5,
    worldTile: { level: 14, x: 0, y: 0 },
    generationSeed: 1,
    groundWidthMeters: 50,
    groundHeightMeters: 50,
    bounds: { lonWest: 0, lonEast: 1, latNorth: 1, latSouth: 0 },
    waterMask: Uint8Array.from(mask),
    originalElevations: Float32Array.from(elevations),
  };
}

const centerBlock = [
  0, 0, 0, 0, 0,
  0, 1, 1, 1, 0,
  0, 1, 1, 1, 0,
  0, 1, 1, 1, 0,
  0, 0, 0, 0, 0,
];

test("collapses one connected terrain-water region into one polygon", async () => {
  const source = terrain(centerBlock);
  const polygons = await buildTerrainLakePolygons(source, source.originalElevations, {
    meshWidth: 10,
    meshDepth: 10,
  });

  assert.equal(polygons.length, 1);
  assert.equal(polygons[0].outline.length, 4);
  assert.equal(polygons[0].holes.length, 0);
  assert.equal(polygons[0].elevationMeters, 40);
});

test("fills the surrounding terrain basin beyond the classified seed", async () => {
  const seed = [
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 1, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
  ];
  const elevations = [
    50, 50, 50, 50, 50,
    50, 39, 39, 39, 50,
    50, 39, 40, 39, 50,
    50, 39, 39, 39, 50,
    50, 50, 50, 50, 50,
  ];
  const source = terrain(seed, elevations);
  const polygons = await buildTerrainLakePolygons(source, source.originalElevations, {
    meshWidth: 10,
    meshDepth: 10,
  });

  assert.equal(polygons.length, 1);
  assert.equal(polygons[0].outline.length, 4);
  assert.deepEqual(
    [
      Math.min(...polygons[0].outline.map((point) => point.x)),
      Math.max(...polygons[0].outline.map((point) => point.x)),
      Math.min(...polygons[0].outline.map((point) => point.z)),
      Math.max(...polygons[0].outline.map((point) => point.z)),
    ],
    [-3, 3, -3, 3],
  );
});

test("keeps terrain islands as holes in a single lake polygon", async () => {
  const ring = [
    1, 1, 1, 1, 1,
    1, 1, 1, 1, 1,
    1, 1, 0, 1, 1,
    1, 1, 1, 1, 1,
    1, 1, 1, 1, 1,
  ];
  const source = terrain(ring);
  source.originalElevations[12] = 50;
  const polygons = await buildTerrainLakePolygons(source, source.originalElevations, {
    meshWidth: 10,
    meshDepth: 10,
  });

  assert.equal(polygons.length, 1);
  assert.equal(polygons[0].holes.length, 1);
});

test("rejects sea-level terrain-water regions", async () => {
  const source = terrain(centerBlock, centerBlock.map(() => -2));
  const polygons = await buildTerrainLakePolygons(source, source.originalElevations, {
    meshWidth: 10,
    meshDepth: 10,
  });

  assert.deepEqual(polygons, []);
});

test("uses a mapped lake position as the terrain polygon identity", async () => {
  const source = terrain(centerBlock);
  const polygons = await buildTerrainLakePolygons(source, source.originalElevations, {
    meshWidth: 10,
    meshDepth: 10,
    seeds: [{ sourceId: "water/14/42", x: 0, z: 0 }],
  });

  assert.equal(polygons[0].sourceId, "water/14/42");
});
