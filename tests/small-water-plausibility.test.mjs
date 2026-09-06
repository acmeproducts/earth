import assert from "node:assert/strict";
import test from "node:test";
import { conformTerrainToLakePolygons } from "../src/TerrainLakePolygons.ts";

function fixture({ halfSize = 5, bank = 10, scale = 1, shift = 0 } = {}) {
  const raw = Float32Array.from({ length: 101 * 101 }, (_, i) => {
    const x = i % 101 - 50;
    const z = 50 - Math.floor(i / 101);
    return Math.abs(x - shift) <= halfSize && Math.abs(z) <= halfSize ? 10 : bank;
  });
  const terrain = {
    width: 101, height: 101, elevations: raw.slice(), minElevation: 10, maxElevation: bank,
  };
  const source = {
    sourceId: "arbitrary-water",
    outline: [[-halfSize, -halfSize], [halfSize, -halfSize],
      [halfSize, halfSize], [-halfSize, halfSize]].map(([x, z]) => ({
        x: (x + shift) / scale, z: z / scale,
      })),
    holes: [],
  };
  const options = {
    meshWidth: 100 / scale, meshDepth: 100 / scale, metersPerUnit: scale,
    smallWaterSurfaceClearanceMeters: 0.35,
    sharedLakeElevations: new Map(), surfaceSources: [source],
  };
  return { raw, terrain, source, options };
}

test("rejects a small unsupported surface before carving or caching its elevation", async () => {
  const { raw, terrain, source, options } = fixture();
  const before = terrain.elevations.slice();
  const result = await conformTerrainToLakePolygons(terrain, raw, [source], options);
  assert.deepEqual(result, []);
  assert.deepEqual(terrain.elevations, before);
  assert.equal(options.sharedLakeElevations.size, 0);
});

test("keeps a small pond with supporting banks", async () => {
  const { raw, terrain, source, options } = fixture({ bank: 12 });
  const result = await conformTerrainToLakePolygons(terrain, raw, [source], options);
  assert.equal(result.length, 1);
});

test("does not reject large lakes or boundary pieces as small puddles", async () => {
  for (const args of [{ halfSize: 15 }, { shift: 45 }]) {
    const { raw, terrain, source, options } = fixture(args);
    const result = await conformTerrainToLakePolygons(terrain, raw, [source], options);
    assert.equal(result.length, 1);
  }
});

test("uses physical metres and also checks an already shared lake level", async () => {
  const { raw, terrain, source, options } = fixture({ scale: 10 });
  options.sharedLakeElevations.set(source.sourceId, 11);
  const result = await conformTerrainToLakePolygons(terrain, raw, [source], options);
  assert.deepEqual(result, []);
});
