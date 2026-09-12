import assert from "node:assert/strict";
import test from "node:test";
import { planBuildingLayout } from "../src/BuildingLayoutPlanner.ts";
import { planApartmentLayout } from "../src/ApartmentLayoutPlanner.ts";
import { planningFrameForPolygon, pointInPlanningFrame } from "../src/PlanningFrame.mjs";
import { polygonArea } from "../src/PolygonGeometry.ts";

for (const angle of [0, 0.47]) {
  test(`apartment walls retain the parent building orientation (${angle})`, () => {
    const outer = [[0, 0], [30, 0], [24, 24], [6, 24]].map(([x, y]) => ({
      x: 100 + x * Math.cos(angle) - y * Math.sin(angle),
      y: -70 + x * Math.sin(angle) + y * Math.cos(angle),
    }));
    const building = planBuildingLayout({ buildingPolygon: { outer }, buildingType: "apartment-building" });
    const planningFrame = planningFrameForPolygon(building.boundary.outer);
    let partitions = 0;
    for (const shell of building.rooms.filter((room) => room.type === "apartment")) {
      const apartment = planApartmentLayout({ apartmentPolygon: shell.polygon, planningFrame });
      const boundary = shell.polygon.outer.map((p) => pointInPlanningFrame(p, planningFrame));
      assert.ok(Math.abs(apartment.rooms.reduce((sum, room) => sum + polygonArea(room.polygon.outer), 0) -
        polygonArea(shell.polygon.outer)) < 1e-6);
      for (const room of apartment.rooms) {
        const points = room.polygon.outer.map((p) => pointInPlanningFrame(p, planningFrame));
        points.forEach((a, i) => {
          const b = points[(i + 1) % points.length];
          if (boundary.some((c, j) => onSegment(a, c, boundary[(j + 1) % boundary.length]) &&
              onSegment(b, c, boundary[(j + 1) % boundary.length]))) return;
          partitions++;
          assert.ok(Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6,
            `room wall rotated away from the building: ${JSON.stringify([a, b])}`);
        });
      }
    }
    assert.ok(partitions > 0, "the layout must still subdivide apartments");
  });
}

function onSegment(p, a, b) {
  return Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < 1e-6 &&
    p.x >= Math.min(a.x, b.x) - 1e-6 && p.x <= Math.max(a.x, b.x) + 1e-6 &&
    p.y >= Math.min(a.y, b.y) - 1e-6 && p.y <= Math.max(a.y, b.y) + 1e-6;
}
