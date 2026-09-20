import assert from "node:assert/strict";
import test from "node:test";
import { LayoutPlanCache } from "../src/buildings/LayoutPlanCache.ts";
import { buildingLayoutCache, planBuildingLayout } from "../src/buildings/BuildingLayoutPlanner.ts";
import { apartmentLayoutCache, planApartmentLayout } from "../src/buildings/ApartmentLayoutPlanner.ts";

const rectangle = (x, y, width, height) => ({ outer: [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
] });
const input = () => ({ buildingType: "apartment-building", buildingPolygon: rectangle(0, 0, 40, 30) });

test("identical floors share plans without sharing mutable results", () => {
  buildingLayoutCache.clear();
  const first = planBuildingLayout(input());
  const expected = structuredClone(first);
  first.rooms[0].polygon.outer[0].x = 999;
  const second = planBuildingLayout(input());
  assert.equal(buildingLayoutCache.hits, 1);
  assert.deepEqual(second, expected);
  second.rooms[0].type = "stairs";
  assert.deepEqual(planBuildingLayout(input()), expected);
});

test("different floor clearances reuse the base shell but retain their own constraints", () => {
  buildingLayoutCache.clear();
  const firstInput = { ...input(), circulation: [rectangle(16, 12, 5, 3)] };
  const secondInput = { ...input(), circulation: [rectangle(16, 12, 5, 3), rectangle(25, 12, 4, 3)] };
  const first = planBuildingLayout(firstInput);
  const hits = buildingLayoutCache.hits;
  const second = planBuildingLayout(secondInput);
  assert.ok(buildingLayoutCache.hits > hits, "the unconstrained shell should be reused");
  assert.notDeepEqual(first, second);
  buildingLayoutCache.clear();
  assert.deepEqual(planBuildingLayout(secondInput), second);
});

test("local-frame cache restores a reused layout at the requested position", () => {
  buildingLayoutCache.clear();
  const original = planBuildingLayout(input());
  const shifted = planBuildingLayout({ ...input(), buildingPolygon: rectangle(100, 200, 40, 30) });
  assert.equal(buildingLayoutCache.hits, 1);
  assert.deepEqual(shifted.boundary.outer, original.boundary.outer.map(({ x, y }) => ({ x: x + 100, y: y + 200 })));
  for (let i = 0; i < original.rooms.length; i++) {
    assert.deepEqual(shifted.rooms[i].polygon.outer,
      original.rooms[i].polygon.outer.map(({ x, y }) => ({ x: x + 100, y: y + 200 })));
  }
});

test("holes, openings, and building type are part of the floor cache key", () => {
  const variants = [input(), { ...input(), buildingType: "house" },
    { ...input(), buildingPolygon: { ...input().buildingPolygon, holes: [rectangle(10, 10, 3, 3).outer] } },
    { ...input(), openings: [{ id: "entry", type: "door", start: { x: 0, y: 10 }, end: { x: 0, y: 12 } }] },
  ];
  const expected = variants.map((value) => { buildingLayoutCache.clear(); return planBuildingLayout(value); });
  buildingLayoutCache.clear();
  variants.forEach((value, i) => assert.deepEqual(planBuildingLayout(value), expected[i]));
});

test("apartment cache retains room-size and opening constraints and isolates results", () => {
  const base = { apartmentPolygon: rectangle(0, 0, 12, 10), minimumRoomAreaSquareMeters: 10 };
  const variants = [base, { ...base, minimumRoomAreaSquareMeters: 20 },
    { ...base, openings: [{ id: "door", type: "door", start: { x: 0, y: 2 }, end: { x: 0, y: 3 } }] }];
  const expected = variants.map((value) => { apartmentLayoutCache.clear(); return planApartmentLayout(value); });
  apartmentLayoutCache.clear();
  variants.forEach((value, i) => assert.deepEqual(planApartmentLayout(value), expected[i]));
  const actual = planApartmentLayout(base);
  assert.equal(apartmentLayoutCache.hits, 1);
  actual.rooms[0].polygon.outer[0].x = 123;
  assert.deepEqual(planApartmentLayout(base), expected[0]);
});

test("cache evicts least recently used plans and does not retain oversized values or failures", () => {
  const cache = new LayoutPlanCache(1000, 2);
  const load = (key) => cache.getOrCreate(key, () => ({ key }));
  load("a"); load("b"); load("a"); load("c");
  assert.equal(cache.size, 2);
  const misses = cache.misses;
  load("b");
  assert.equal(cache.misses, misses + 1);
  cache.getOrCreate("large", () => "x".repeat(1000));
  assert.ok(cache.bytes <= 1000);
  assert.throws(() => cache.getOrCreate("failed", () => { throw new Error("invalid plan"); }));
  assert.equal(cache.getOrCreate("failed", () => "retry"), "retry");
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);
});
