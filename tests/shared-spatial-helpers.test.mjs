import assert from "node:assert/strict";
import test from "node:test";
import { ringEdges, pointInPolygon } from "../src/core/Geometry2D.ts";
import { closestPointOnSegment, distanceToRing } from "../src/core/PlanarGeometry.ts";
import { sampleGridBilinear, mapGridRange } from "../src/core/GridSampling.ts";
import { distanceTransformRow } from "../src/core/DistanceTransform.ts";
import { visitTerrainRaster } from "../src/terrain/TerrainRaster.ts";

test("ring traversal closes the final edge and handles empty and singleton rings", () => {
  assert.deepEqual([...ringEdges([])], []);
  assert.deepEqual([...ringEdges([1])], [[1, 1]]);
  assert.deepEqual([...ringEdges([1, 2, 3])], [[1, 2], [2, 3], [3, 1]]);
});

test("polygon membership supports coordinate adapters and either winding", () => {
  const triangle = [[0, 0], [4, 0], [0, 4]];
  const inside = (x, y, polygon) => pointInPolygon(x, y, polygon, p => p[0], p => p[1]);
  for (const polygon of [triangle, triangle.toReversed()]) {
    assert.equal(inside(1, 1, polygon), true);
    assert.equal(inside(3, 3, polygon), false);
  }
  assert.equal(inside(0, 0, []), false);
});

test("segment projection clamps to endpoints and handles zero-length edges", () => {
  const start = { x: 0, z: 0 }, end = { x: 4, z: 0 };
  assert.deepEqual(closestPointOnSegment({ x: 2, z: 3 }, start, end), { x: 2, z: 0 });
  assert.deepEqual(closestPointOnSegment({ x: -2, z: 3 }, start, end), start);
  assert.deepEqual(closestPointOnSegment({ x: 7, z: 3 }, start, end), end);
  assert.deepEqual(closestPointOnSegment({ x: 7, z: 3 }, end, end), end);
  assert.equal(distanceToRing({ x: 2, z: 3 }, [start, end]), 3);
  assert.equal(distanceToRing({ x: 7, z: 4 }, [end]), 5);
  assert.equal(distanceToRing(start, []), Infinity);
});

test("bilinear sampling preserves corners, interpolates ramps, and handles singleton grids", () => {
  const values = new Float32Array([0, 4, 8, 12]);
  assert.equal(sampleGridBilinear(values, 2, 2, 0, 0), 0);
  assert.equal(sampleGridBilinear(values, 2, 2, 1, 1), 12);
  assert.equal(sampleGridBilinear(values, 2, 2, 0.25, 0.5), 5);
  assert.equal(sampleGridBilinear([7], 1, 1, 0, 0), 7);
  assert.deepEqual(mapGridRange(2, 3, 4, 5, (x, y) => [x, y]), [[2, 4], [2, 5], [3, 4], [3, 5]]);
  assert.deepEqual(mapGridRange(2, 1, 4, 5, () => assert.fail()), []);
});

test("distance transforms propagate both ways with anisotropic spacing", () => {
  const distance = new Float32Array(9).fill(Infinity);
  distance[4] = 0;
  for (const reverse of [false, true]) {
    for (let row = 0; row < 3; row++) {
      distanceTransformRow(distance, 3, 3, 2, 3, Math.sqrt(13), reverse, reverse ? 2 - row : row);
    }
  }
  const diagonal = Math.fround(Math.sqrt(13));
  assert.deepEqual([...distance], [diagonal, 3, diagonal, 2, 0, 2, diagonal, 3, diagonal]);
});

test("terrain traversal preserves scene coordinates and awaits each row before continuing", async () => {
  const events = [];
  await visitTerrainRaster({ width: 2, height: 2 }, { meshWidth: 10, meshDepth: 20 },
    (index, x, z) => events.push([index, x, z]),
    async () => { await Promise.resolve(); events.push("yield"); });
  assert.deepEqual(events, [[0, -5, 10], [1, 5, 10], "yield", [2, -5, -10], [3, 5, -10], "yield"]);
});
