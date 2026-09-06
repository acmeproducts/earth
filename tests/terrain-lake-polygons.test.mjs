import assert from "node:assert/strict";
import test from "node:test";


const { conformTerrainToLakePolygons } = await import("../src/TerrainLakePolygons.ts");

function terrain(elevations) {
  return {
    elevations: Float32Array.from(elevations),
    minElevation: Math.min(...elevations),
    maxElevation: Math.max(...elevations),
    width: 5,
    height: 5,
    worldTile: { level: 14, x: 0, y: 0 },
    generationSeed: 1,
    groundWidthMeters: 10,
    groundHeightMeters: 10,
    bounds: { lonWest: 0, lonEast: 1, latNorth: 1, latSouth: 0 },
  };
}

function square(sourceId = "water/14/42") {
  return {
    sourceId,
    outline: [
      { x: -2.5, z: -2.5 },
      { x: 2.5, z: -2.5 },
      { x: 2.5, z: 2.5 },
      { x: -2.5, z: 2.5 },
    ],
    holes: [],
  };
}

const sourceElevations = [
  50, 50, 50, 50, 50,
  50, 40, 40, 40, 50,
  50, 40, 40, 40, 50,
  50, 40, 40, 40, 50,
  50, 50, 50, 50, 50,
];

test("uses the OSM outline and one robust interior DEM level", async () => {
  const grid = terrain(new Array(25).fill(50));
  const lakes = await conformTerrainToLakePolygons(
    grid,
    Float32Array.from(sourceElevations),
    [square()],
    {
      meshWidth: 10,
      meshDepth: 10,
      metersPerUnit: 1,
      shorelineBlendMeters: 2,
    },
  );

  assert.equal(lakes.length, 1);
  assert.deepEqual(lakes[0].outline, square().outline);
  assert.equal(lakes[0].sourceId, "water/14/42");
  assert.equal(lakes[0].elevationMeters, 40);
});

test("caps an elevated interior DEM level at the lower surrounding shoreline", async () => {
  const grid = terrain(new Array(25).fill(50));
  const elevations = new Float32Array(25).fill(42);
  for (let row = 1; row <= 3; row++) {
    for (let column = 1; column <= 3; column++) {
      elevations[row * 5 + column] = 80;
    }
  }
  // A few steep bank samples must not pull the whole water surface uphill.
  elevations[0] = 95;
  elevations[4] = 95;

  const lakes = await conformTerrainToLakePolygons(
    grid,
    elevations,
    [square()],
    {
      meshWidth: 10,
      meshDepth: 10,
      metersPerUnit: 1,
      shorelineBlendMeters: 2,
    },
  );

  assert.equal(lakes[0].elevationMeters, 42);
  assert.equal(grid.elevations[2 * 5 + 2], 40);
});

test("slopes the lake bed down from the vector shore and leaves distant terrain alone", async () => {
  const grid = terrain(new Array(25).fill(50));
  await conformTerrainToLakePolygons(
    grid,
    Float32Array.from(sourceElevations),
    [square()],
    {
      meshWidth: 10,
      meshDepth: 10,
      metersPerUnit: 1,
      shorelineBlendMeters: 2,
      lakeBedDepthMeters: 2,
    },
  );

  assert.equal(grid.elevations[2 * 5 + 2], 38);
  assert.equal(grid.elevations[0], 50);
  assert.equal(grid.minElevation, 38);
});

test("repairs the wider raster-carved valley outside a smaller OSM lake", async () => {
  const raw = new Float32Array(81).fill(50);
  for (let row = 3; row <= 5; row++) {
    for (let column = 3; column <= 5; column++) raw[row * 9 + column] = 40;
  }
  const grid = {
    ...terrain(new Array(25).fill(50)),
    elevations: new Float32Array(81).fill(10),
    width: 9,
    height: 9,
    groundWidthMeters: 20,
    groundHeightMeters: 20,
  };
  await conformTerrainToLakePolygons(
    grid,
    raw,
    [square()],
    {
      meshWidth: 20,
      meshDepth: 20,
      metersPerUnit: 1,
      shorelineBlendMeters: 1,
      rasterRepairMeters: 8,
      rasterRepairFadeMeters: 2,
    },
  );

  // Five metres east of centre is outside the water and its narrow shore
  // blend, but still inside the obsolete WorldCover depression being repaired.
  assert.equal(grid.elevations[4 * 9 + 6], 50);
  // Terrain beyond the softly bounded repair remains owned by WorldCover.
  assert.equal(grid.elevations[0], 10);
});

test("reuses one lake level across independently streamed tile pieces", async () => {
  const sharedLakeElevations = new Map();
  const first = terrain(new Array(25).fill(40));
  const second = terrain(new Array(25).fill(60));
  const options = {
    meshWidth: 10,
    meshDepth: 10,
    metersPerUnit: 1,
    sharedLakeElevations,
  };

  const firstLakes = await conformTerrainToLakePolygons(
    first,
    new Float32Array(25).fill(40),
    [square()],
    options,
  );
  const secondLakes = await conformTerrainToLakePolygons(
    second,
    new Float32Array(25).fill(60),
    [square()],
    options,
  );

  assert.equal(firstLakes[0].elevationMeters, 40);
  assert.equal(secondLakes[0].elevationMeters, 40);
  assert.equal(sharedLakeElevations.get("water/14/42"), 40);
});

test("uses padded lake rings for deformation but returns tile-clipped water", async () => {
  const grid = terrain(new Array(25).fill(10));
  const contextLake = {
    ...square(),
    outline: square().outline.map(({ x, z }) => ({ x: x + 5.5, z })),
  };
  const surfaceLake = {
    ...contextLake,
    outline: contextLake.outline.map(({ x, z }) => ({ x: Math.min(5, x), z })),
  };
  const sharedLakeElevations = new Map([[contextLake.sourceId, 4]]);

  const lakes = await conformTerrainToLakePolygons(
    grid,
    new Float32Array(25).fill(50),
    [contextLake],
    {
      meshWidth: 10,
      meshDepth: 10,
      metersPerUnit: 1,
      shorelineBlendMeters: 2,
      rasterRepairMeters: 4,
      sharedLakeElevations,
      surfaceSources: [surfaceLake],
    },
  );

  // The padded ring lies mostly in the eastern neighbor but still shapes this edge.
  assert.notEqual(grid.elevations[2 * 5 + 4], 10);
  assert.deepEqual(lakes[0].outline, surfaceLake.outline);
  assert.equal(lakes[0].elevationMeters, 4);
});

test("preserves mapped islands as holes in the water surface", async () => {
  const grid = terrain(new Array(25).fill(50));
  const lake = square();
  lake.holes = [[
    { x: -1, z: -1 },
    { x: -1, z: 1 },
    { x: 1, z: 1 },
    { x: 1, z: -1 },
  ]];
  const elevations = Float32Array.from(sourceElevations);
  elevations[2 * 5 + 2] = 50;
  const lakes = await conformTerrainToLakePolygons(
    grid,
    elevations,
    [lake],
    {
      meshWidth: 10,
      meshDepth: 10,
      metersPerUnit: 1,
      shorelineBlendMeters: 0.5,
    },
  );

  assert.equal(lakes[0].holes.length, 1);
  assert.equal(grid.elevations[2 * 5 + 2], 50);
});

test("rejects mapped water below the inland-water threshold", async () => {
  const grid = terrain(new Array(25).fill(-2));
  const lakes = await conformTerrainToLakePolygons(
    grid,
    new Float32Array(25).fill(-2),
    [square()],
    { meshWidth: 10, meshDepth: 10, metersPerUnit: 1 },
  );

  assert.deepEqual(lakes, []);
});

test("low shoreline outlets lower the lake instead of becoming tall artificial banks", async () => {
  const raw = new Float32Array(25).fill(80);
  // A short low outlet was missed by the former 15th-percentile shore estimate.
  raw[10] = 20;
  raw[15] = 20;
  const grid = terrain(raw);
  const lakes = await conformTerrainToLakePolygons(grid, raw, [square()], {
    meshWidth: 10, meshDepth: 10, metersPerUnit: 1, shorelineBlendMeters: 3,
  });
  assert.equal(lakes[0].elevationMeters, 20);
  assert.ok(grid.elevations[10] <= 20.5);
});

test("an established high lake cannot raise lower streamed terrain into a plateau", async () => {
  for (const metersPerUnit of [1, 10]) {
    const raw = new Float32Array(25).fill(20);
    const grid = terrain(raw);
    const source = square();
    source.outline = source.outline.map(({ x, z }) => ({
      x: x / metersPerUnit, z: z / metersPerUnit,
    }));
    const options = {
      meshWidth: 10 / metersPerUnit, meshDepth: 10 / metersPerUnit, metersPerUnit,
      sharedLakeElevations: new Map([[source.sourceId, 80]]),
    };
    const lakes = await conformTerrainToLakePolygons(grid, raw, [source], options);
    assert.equal(lakes[0].elevationMeters, 80);
    assert.ok(grid.elevations.every(height => height <= 20.5));
    await conformTerrainToLakePolygons(grid, raw, [source], options);
    assert.ok(grid.elevations.every(height => height <= 20.5));
  }
});

test("retains deep lake beds rather than filling them to the water surface", async () => {
  const raw = new Float32Array(25).fill(40);
  raw[12] = 5;
  const grid = terrain(raw);
  await conformTerrainToLakePolygons(grid, raw, [square()], {
    meshWidth: 10, meshDepth: 10, metersPerUnit: 1,
    sharedLakeElevations: new Map([[square().sourceId, 40]]),
  });
  assert.ok(grid.elevations[12] <= 5.5);
});
