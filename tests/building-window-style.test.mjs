import assert from "node:assert/strict";
import test from "node:test";

const { planBuilding } = await import("../src/buildings/BuildingPlanner.ts");
const { buildingWindowStyle, windowRegionAt } = await import(
  "../src/buildings/BuildingWindowStyle.ts"
);

function planAt(id, longitude, latitude) {
  const footprint = {
    outer: [
      [longitude - 0.001, latitude - 0.001],
      [longitude + 0.001, latitude - 0.001],
      [longitude + 0.001, latitude + 0.001],
      [longitude - 0.001, latitude + 0.001],
      [longitude - 0.001, latitude - 0.001],
    ],
    holes: [],
  };
  return planBuilding({ id: `building/${id}`, polygon: footprint, properties: {} });
}

test("maps representative locations to architecture-specific window regions", () => {
  assert.equal(windowRegionAt(10.75, 59.91), "nordic");
  assert.equal(windowRegionAt(12.5, 41.9), "mediterranean");
  assert.equal(windowRegionAt(31.2, 27.2), "arid");
  assert.equal(windowRegionAt(-60, -3), "tropical");
  assert.equal(windowRegionAt(139.7, 35.7), "east-asian");
  assert.equal(windowRegionAt(-74, 40.7), "north-american");
  assert.equal(windowRegionAt(14.4, 50.1), "continental");
});

test("regional palettes produce distinct stable window languages", () => {
  const locations = [
    ["oslo", 10.75, 59.91],
    ["rome", 12.5, 41.9],
    ["luxor", 31.2, 27.2],
    ["manaus", -60, -3],
    ["tokyo", 139.7, 35.7],
    ["new-york", -74, 40.7],
  ];
  const styles = locations.map(([id, longitude, latitude]) =>
    buildingWindowStyle(planAt(id, longitude, latitude))
  );
  assert.equal(new Set(styles.map((style) => style.region)).size, locations.length);
  assert.ok(new Set(styles.map((style) => style.id)).size >= 5);
  assert.ok(new Set(styles.map((style) => style.verticalBars.join(",") + "/" +
    style.horizontalBars.join(","))).size >= 4);

  const oslo = planAt("stable", 10.75, 59.91);
  assert.deepEqual(buildingWindowStyle(oslo), buildingWindowStyle(oslo));
});
