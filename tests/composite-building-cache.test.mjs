import assert from "node:assert/strict";
import test from "node:test";
import { mergeBuildingSourceGroups, mergeOverlappingBuildings } from "../src/buildings/CompositeBuildings.ts";

function building(id, x) {
  return { id, polygon: { outer: [[x, 0], [x + 2, 0], [x + 2, 2], [x, 2], [x, 0]], holes: [] },
    properties: { height: 10 } };
}

test("fresh provider arrays reuse identical ordered decoded source groups", () => {
  const a = [building("a", 0)];
  const b = [building("b", 1)];
  const before = structuredClone([a, b]);
  const first = mergeBuildingSourceGroups([a, b]);
  assert.deepEqual(first, mergeOverlappingBuildings([...a, ...b]));
  assert.equal(first.length, 1);
  for (let i = 0; i < 64; i++) assert.strictEqual(mergeBuildingSourceGroups([a, b]), first);
  assert.deepEqual([a, b], before);
});

test("changed, reordered, added and removed groups do not reuse a stale composition", () => {
  const a = [building("a", 0)];
  const b = [building("b", 1)];
  const first = mergeBuildingSourceGroups([a, b]);
  for (const groups of [[b, a], [a], [a, b, []], [a, structuredClone(b)], [[building("a", 20)], b]]) {
    const result = mergeBuildingSourceGroups(groups);
    assert.notStrictEqual(result, first);
    assert.deepEqual(result, mergeOverlappingBuildings(groups.flat()));
    assert.strictEqual(mergeBuildingSourceGroups([...groups]), result);
  }
  assert.strictEqual(mergeBuildingSourceGroups([a, b]), first);
});

test("empty and prefix groups have distinct cached results", () => {
  const empty = [];
  const a = [building("a", 0)];
  const none = mergeBuildingSourceGroups([]);
  const prefix = mergeBuildingSourceGroups([empty]);
  const full = mergeBuildingSourceGroups([empty, a]);
  assert.deepEqual(none, []);
  assert.deepEqual(prefix, []);
  assert.notStrictEqual(prefix, none);
  assert.equal(full.length, 1);
  assert.strictEqual(mergeBuildingSourceGroups([empty]), prefix);
});
