import assert from "node:assert/strict";
import test from "node:test";
import { decomposeToConvexPolygons } from "../src/core/PolygonDecomposition.mjs";
import { planningFrameForPolygon, pointInPlanningFrame } from "../src/core/PlanningFrame.mjs";

const outlines = [
  // Opposing recesses require cuts that terminate at existing vertices.
  [[0, 0], [12, 0], [12, 4], [8, 4], [8, 8], [12, 8],
    [12, 12], [0, 12], [0, 8], [4, 8], [4, 4], [0, 4]],
  // An angled facade must not rotate the partition axes in a child piece.
  [[0, 0], [20, 0], [20, 4], [11, 8], [16, 14], [6, 16], [6, 6], [0, 6]],
];

for (let seed = 1; seed <= 30; seed++) {
  const points = Array.from({ length: 8 + seed % 7 }, (_, i) => {
    const angle = i * Math.PI * 2 / (8 + seed % 7);
    const radius = 10 + 4 * Math.sin(i * 2.4 + seed * 7);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
  const frame = planningFrameForPolygon(points);
  outlines.push(points.map((point) => {
    const local = pointInPlanningFrame(point, frame);
    return [local.x, local.y];
  }));
}

for (const [index, coordinates] of outlines.entries()) {
  test(`concave decomposition keeps interior walls orthogonal (${index})`, () => {
    const outline = coordinates.map(([x, y]) => ({ x, y }));
    for (const points of [outline, [...outline].reverse()]) {
      const pieces = decomposeToConvexPolygons(points);
      assert.ok(pieces.length > 1);
      assert.ok(Math.abs(pieces.reduce((sum, piece) => sum + area(piece), 0) - area(points)) < 1e-6);
      for (const piece of pieces) {
        for (let edge = 0; edge < piece.length; edge++) {
          const a = piece[edge];
          const b = piece[(edge + 1) % piece.length];
          const exterior = points.some((start, i) =>
            onSegment(a, start, points[(i + 1) % points.length]) &&
            onSegment(b, start, points[(i + 1) % points.length]));
          assert.ok(exterior || Math.abs(a.x - b.x) < 1e-7 || Math.abs(a.y - b.y) < 1e-7,
            `diagonal interior wall ${JSON.stringify([a, b])}`);
        }
      }
    }
  });
}

function onSegment(point, a, b) {
  return Math.abs((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) < 1e-6 &&
    point.x >= Math.min(a.x, b.x) - 1e-7 && point.x <= Math.max(a.x, b.x) + 1e-7 &&
    point.y >= Math.min(a.y, b.y) - 1e-7 && point.y <= Math.max(a.y, b.y) + 1e-7;
}

test("retains an unsplittable concave fragment without triangulation walls", () => {
  const points = outlines[1].map(([x, y]) => ({ x: x * 0.001, y: y * 0.001 }));
  assert.deepEqual(decomposeToConvexPolygons(points), [points]);
});

function area(points) {
  return Math.abs(points.reduce((sum, a, i) => {
    const b = points[(i + 1) % points.length];
    return sum + a.x * b.y - b.x * a.y;
  }, 0)) / 2;
}
