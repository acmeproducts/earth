import assert from "node:assert/strict";
import test from "node:test";
import polygonClipping from "polygon-clipping";
import { intersectInteriorSections } from "../src/procedural/InteriorSectionIntersection.ts";

const box = (x, z, width, depth) => [[x, z], [x + width, z], [x + width, z + depth], [x, z + depth]];
const failure = () => new Error("Unable to find segment #365243 in SweepLine tree.");

test("normal intersections are unchanged, including holes and separate components", () => {
  const first = [box(0, 0, 10, 10), box(3, 3, 4, 4)];
  const second = [box(4, -1, 2, 12)];
  assert.deepEqual(intersectInteriorSections(first, second, 6), polygonClipping.intersection(first, second));
});

test("sweep-line recovery removes the reported tiny edge and preserves courtyard voids across scene scales", (t) => {
  const original = polygonClipping.intersection;
  for (const metersPerUnit of [0.5, 1, 6, 20]) {
    const x = -9.326171875, z = -24.804687495633576;
    const ring = box(x, z, 10 / metersPerUnit, 10 / metersPerUnit);
    ring.splice(1, 0, [-9.326171872546027, -24.804687497480955]);
    const polygon = [ring, box(x + 3 / metersPerUnit, z + 3 / metersPerUnit, 4 / metersPerUnit, 4 / metersPerUnit)];
    const before = structuredClone(polygon);
    let calls = 0;
    const mock = t.mock.method(polygonClipping, "intersection", (...args) => {
      if (++calls === 1) throw failure();
      assert.ok(args.flat(3).every(Number.isInteger));
      assert.equal(args[0][0].length, 4);
      return original(...args);
    });
    const result = intersectInteriorSections(polygon, polygon, metersPerUnit);
    assert.equal(calls, 2);
    assert.equal(result.length, 1);
    assert.equal(result[0].length, 2);
    assert.deepEqual(polygon, before);
    const expected = original([box(x, z, 10 / metersPerUnit, 10 / metersPerUnit), polygon[1]],
      [box(x, z, 10 / metersPerUnit, 10 / metersPerUnit), polygon[1]]).flat(3);
    assert.equal(result.flat(3).length, expected.length);
    result.flat(3).forEach((value, i) => assert.ok(Math.abs(value - expected[i]) * metersPerUnit < 1e-9));
    mock.mock.restore();
  }
});

test("coarser recovery succeeds when the first retry still has a precision failure", (t) => {
  const original = polygonClipping.intersection;
  let calls = 0;
  t.mock.method(polygonClipping, "intersection", (...args) => {
    if (++calls < 3) throw failure();
    assert.equal(args[0][0][1][0], 5000);
    return original(...args);
  });
  assert.equal(intersectInteriorSections([box(0, 0, 5, 5)], [box(0, 0, 5, 5)], 1).length, 1);
  assert.equal(calls, 3);
});

test("retries at most twice and never conceals unrelated or persistent failures", (t) => {
  const polygon = [box(0, 0, 5, 5)];
  const error = failure();
  let calls = 0;
  const mock = t.mock.method(polygonClipping, "intersection", () => { calls++; throw error; });
  assert.throws(() => intersectInteriorSections(polygon, polygon, 1), (value) => value === error);
  assert.equal(calls, 3);
  mock.mock.restore();
  t.mock.method(polygonClipping, "intersection", () => { throw new Error("invalid input"); });
  assert.throws(() => intersectInteriorSections(polygon, polygon, 1), /invalid input/);
});
