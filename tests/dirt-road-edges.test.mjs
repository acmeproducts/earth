import test from "node:test";
import assert from "node:assert/strict";
import { dirtRoadEdgeCoordinates } from "../src/roads/DirtRoadEdges.ts";

const road = {
  centerline: [{ x: 0, z: 0 }, { x: 20, z: 0 }],
  widthMeters: 2,
  gradeRange: [0.05, 0.95],
};

test("dirt edges distinguish exposed sides from solid junction boundaries", () => {
  assert.deepEqual(dirtRoadEdgeCoordinates({ x: 10, z: 1 }, road, 1), [1, 4.5, 4.5]);
  assert.deepEqual(dirtRoadEdgeCoordinates({ x: 1, z: 1 }, road, 1), [1, 0, 9]);
  assert.deepEqual(dirtRoadEdgeCoordinates({ x: 19, z: 1 }, road, 1), [1, 9, 0]);
  assert.equal(dirtRoadEdgeCoordinates({ x: 10, z: 0 }, road, 1)[0], 0);
});

test("join discs, bend wedges and short dirt pieces remain solid", () => {
  for (const patch of [
    { ...road, junctionArms: [] },
    { ...road, centerline: [{ x: 0, z: 0 }, { x: 0, z: 0 }] },
    { ...road, centerline: [{ x: 0, z: 0 }, { x: 3, z: 0 }] },
  ]) {
    assert.deepEqual(dirtRoadEdgeCoordinates({ x: 1, z: 1 }, patch, 1), [0, 0, 0]);
  }
});

test("fade coordinates interpolate across triangles without fading the road centre", () => {
  const a = dirtRoadEdgeCoordinates({ x: 3, z: -1 }, road, 1);
  const b = dirtRoadEdgeCoordinates({ x: 17, z: 1 }, road, 1);
  const interpolated = a.map((value, index) => (value + b[index]) / 2);
  assert.deepEqual(interpolated, dirtRoadEdgeCoordinates({ x: 10, z: 0 }, road, 1));
});

test("fade distances follow road width at different scene scales and orientations", () => {
  const rotated = {
    ...road,
    centerline: [{ x: 3, z: 4 }, { x: 3, z: 14 }],
  };
  assert.deepEqual(
    dirtRoadEdgeCoordinates({ x: 2.5, z: 9 }, rotated, 2),
    dirtRoadEdgeCoordinates({ x: 10, z: 1 }, road, 1),
  );
});
