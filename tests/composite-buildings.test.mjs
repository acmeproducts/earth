import assert from "node:assert/strict";
import test from "node:test";
import { mergeOverlappingBuildings } from "../src/buildings/CompositeBuildings.ts";
import { planBuilding } from "../src/buildings/BuildingPlanner.ts";
import { buildingOwnerWorldTile } from "../src/buildings/BuildingTileOwnership.ts";

const rectangle = (x, y, width, depth) => [
  [x, y], [x + width, y], [x + width, y + depth], [x, y + depth], [x, y],
];
const source = (id, outer, properties = {}, holes = []) => ({ id, polygon: { outer, holes }, properties });
const ringArea = (ring) => Math.abs(ring.reduce((sum, a, i) => {
  const b = ring[(i + 1) % ring.length];
  return sum + a[0] * b[1] - b[0] * a[1];
}, 0)) / 2;
const area = ({ polygon }) => ringArea(polygon.outer) - polygon.holes.reduce((sum, ring) => sum + ringArea(ring), 0);

test("unions partially overlapping footprints without filling their concave boundary", () => {
  const result = mergeOverlappingBuildings([
    source("a", rectangle(0, 0, 4, 2)), source("b", rectangle(2, 1, 2, 3)),
  ]);
  assert.equal(result.length, 1);
  assert.equal(area(result[0]), 12);
  assert.equal(result[0].polygon.outer.length, 7);
});

test("absorbs nested buildings and retains the tallest height and primary appearance", () => {
  const result = mergeOverlappingBuildings([
    source("outer", rectangle(0, 0, 10, 10), { render_height: 8, colour: "red", building: "office" }),
    source("inner", rectangle(2, 2, 2, 2), { render_height: 20, levels: 6, colour: "blue" }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(area(result[0]), 100);
  const plan = planBuilding(result[0]);
  assert.equal(plan.heightMeters, 20);
  assert.equal(plan.levels, 6);
  assert.equal(plan.wallColor, "red");
  assert.equal(plan.interiorUse, "office");
});

test("merges transitive overlaps with stable geometry, identity, and tile ownership", () => {
  const parts = [
    source("a", rectangle(18, 59, 0.002, 0.002)),
    source("b", rectangle(18.001, 59, 0.002, 0.002)),
    source("c", rectangle(18.0025, 59, 0.002, 0.002)),
  ];
  const first = mergeOverlappingBuildings(parts);
  const reversed = mergeOverlappingBuildings([...parts].reverse());
  assert.equal(first.length, 1);
  assert.deepEqual(first, reversed);
  assert.deepEqual(buildingOwnerWorldTile(first[0].polygon, 16), buildingOwnerWorldTile(reversed[0].polygon, 16));
});

test("keeps disjoint buildings, shared walls, and corner contacts separate", () => {
  const parts = [source("a", rectangle(0, 0, 2, 2)), source("b", rectangle(2, 0, 2, 2)),
    source("c", rectangle(4, 2, 2, 2)), source("d", rectangle(10, 10, 2, 2))];
  assert.deepEqual(mergeOverlappingBuildings(parts), parts);
});

test("preserves courtyards and independent buildings inside courtyard holes", () => {
  const parts = [
    source("a", rectangle(0, 0, 10, 10), {}, [rectangle(2, 2, 6, 6)]),
    source("b", rectangle(9, 0, 3, 10)),
    source("courtyard-building", rectangle(3, 3, 1, 1)),
  ];
  const result = mergeOverlappingBuildings(parts);
  assert.equal(result.length, 2);
  const merged = result.find((part) => part.id.startsWith("composite:"));
  assert.equal(merged.polygon.holes.length, 1);
  assert.equal(area(merged), 84);
  assert.ok(result.includes(parts[2]));
});

test("overlapping parts fill only the occupied portion of a courtyard", () => {
  const [merged] = mergeOverlappingBuildings([
    source("a", rectangle(0, 0, 10, 10), {}, [rectangle(2, 2, 6, 6)]),
    source("b", rectangle(0, 0, 5, 10)),
  ]);
  assert.equal(merged.polygon.holes.length, 1);
  assert.equal(area(merged), 82);
});

test("does not merge vertically separated volumes", () => {
  const parts = [source("ground", rectangle(0, 0, 4, 4), { render_height: 5 }),
    source("above", rectangle(1, 1, 2, 2), { render_min_height: 6, render_height: 10 })];
  assert.deepEqual(mergeOverlappingBuildings(parts), parts);
});

test("handles empty batches and duplicate provider footprints", () => {
  assert.deepEqual(mergeOverlappingBuildings([]), []);
  const building = source("same", rectangle(0, 0, 2, 2));
  const result = mergeOverlappingBuildings([building, structuredClone(building)]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "same");
  assert.equal(area(result[0]), 4);
});
