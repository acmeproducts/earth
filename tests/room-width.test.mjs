import assert from "node:assert/strict";
import test from "node:test";
import { planApartmentLayout } from "../src/buildings/ApartmentLayoutPlanner.ts";
import { planBuildingLayout } from "../src/buildings/BuildingLayoutPlanner.ts";
import { polygonMinimumMeanWidth, polygonArea } from "../src/core/PolygonGeometry.ts";

const planningFrame = { origin: { x: 0, y: 0 }, xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 } };

test("large tapered buildings do not subdivide apartments into narrow strips", () => {
  const buildingPolygon = { outer: [[0, 0], [60, 0], [40, 20], [0, 20]].map(([x, y]) => ({ x, y })) };
  const layout = planBuildingLayout({ buildingPolygon, buildingType: "apartment-building" });
  const apartments = layout.rooms.filter((room) => room.type === "apartment");
  assert.ok(apartments.length > 1);
  for (const room of apartments) {
    assert.ok(polygonArea(room.polygon.outer) >= 24 - 1e-7);
    assert.ok(polygonMinimumMeanWidth(room.polygon.outer) >= 2.8 - 1e-7);
  }
});

test("does not chop a diagonal narrow shell into a row of sliver rooms", () => {
  const apartmentPolygon = { outer: [[0, 0], [20, 20], [20, 23], [0, 3]].map(([x, y]) => ({ x, y })) };
  const layout = planApartmentLayout({ apartmentPolygon, planningFrame });
  assert.equal(layout.rooms.length, 1);
});

test("does not turn a thin concave wing into many small rooms", () => {
  const apartmentPolygon = { outer: [[0, 0], [20, 0], [20, 2], [2, 2], [2, 20], [0, 20]]
    .map(([x, y]) => ({ x, y })) };
  const layout = planApartmentLayout({ apartmentPolygon, planningFrame });
  assert.equal(layout.rooms.length, 1);
});

test("keeps a tapered tip attached to a room with useful depth", () => {
  const apartmentPolygon = { outer: [[0, 0], [30, 0], [0, 8]].map(([x, y]) => ({ x, y })) };
  const layout = planApartmentLayout({ apartmentPolygon, planningFrame });
  assert.ok(layout.rooms.length > 1);
  for (const room of layout.rooms) {
    const p = room.polygon.outer;
    const area = Math.abs(p.reduce((sum, a, i) => {
      const b = p[(i + 1) % p.length];
      return sum + a.x * b.y - b.x * a.y;
    }, 0)) / 2;
    const span = Math.max(...p.map((a) => a.x)) - Math.min(...p.map((a) => a.x));
    assert.ok(area / span >= 2.8 - 1e-7, `average room depth is only ${area / span}`);
  }
});
