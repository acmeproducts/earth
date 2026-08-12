import assert from "node:assert/strict";
import test from "node:test";
import { SpatialReferenceGrid } from "../src/SpatialReferenceGrid.ts";

test("spatial grid stores and returns the original references", () => {
  const inside = { name: "inside" };
  const hole = { name: "hole" };
  const outside = { name: "outside" };
  const grid = new SpatialReferenceGrid([
    { x: 9, z: 0, value: inside },
    { x: 1, z: 0, value: hole },
    { x: 30, z: 0, value: outside },
  ], 2);

  const candidates = grid.queryAnnulusBounds(0, 0, 8, 12);
  assert.ok(candidates.includes(inside));
  assert.ok(!candidates.includes(hole));
  assert.ok(!candidates.includes(outside));
  assert.equal(candidates[0], inside);
});

test("annulus bounds include edge cells conservatively in every quadrant", () => {
  const references = [
    { x: -10, z: -1, value: "west" },
    { x: 1, z: 10, value: "north" },
    { x: 7, z: 7, value: "diagonal" },
  ];
  const grid = new SpatialReferenceGrid(references, 3);
  const candidates = new Set(grid.queryAnnulusBounds(0, 0, 9, 11));
  assert.deepEqual(candidates, new Set(references.map(({ value }) => value)));
});
