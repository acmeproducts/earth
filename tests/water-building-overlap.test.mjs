import assert from "node:assert/strict";
import test from "node:test";
import { createWaterBuildingOverlapFilter } from "../src/WaterBuildingOverlap.ts";

function box(x, z, width, depth) {
  return { outline: [
    { x, z }, { x: x + width, z },
    { x: x + width, z: z + depth }, { x, z: z + depth },
  ], holes: [] };
}
const water = box(0, 0, 10, 10);
const reject = (buildings, body = water) => createWaterBuildingOverlapFilter(buildings, 20)(body);

test("rejects water completely inside a house or substantially overlapping it", () => {
  assert.equal(reject([box(-1, -1, 12, 12)]), true);
  assert.equal(reject([box(5, 0, 10, 10)]), true);
  assert.equal(reject([box(7.5, 0, 10, 10)]), true);
});

test("retains separate water, touching edges and minor map overlap", () => {
  for (const x of [20, 10, 9, 7.6]) assert.equal(reject([box(x, 0, 10, 10)]), false);
});

test("combines several buildings without counting duplicate or overlapping footprints twice", () => {
  const first = box(0, 0, 2, 10);
  assert.equal(reject([first, box(8, 0, 2, 10)]), true);
  assert.equal(reject([first, first, box(0.1, 0, 2, 10)]), false);
});

test("preserves water in a building courtyard and buildings on water islands", () => {
  const building = box(-5, -5, 20, 20);
  building.holes = [box(-1, -1, 12, 12).outline];
  assert.equal(reject([building]), false);
  const lake = box(-5, -5, 20, 20);
  lake.holes = [box(-1, -1, 12, 12).outline];
  assert.equal(reject([water], lake), false);
});

test("uses polygon geometry rather than overlapping bounding boxes", () => {
  const building = {
    outline: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 2 },
      { x: 2, z: 2 }, { x: 2, z: 10 }, { x: 0, z: 10 }], holes: [],
  };
  assert.equal(reject([building], box(3, 3, 6, 6)), false);
});

test("is independent of polygon winding", () => {
  const building = box(5, 0, 10, 10);
  building.outline.reverse();
  assert.equal(reject([building], { outline: [...water.outline].reverse(), holes: [] }), true);
});
