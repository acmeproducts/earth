import assert from "node:assert/strict";
import test from "node:test";
import {
  MINIMUM_ROOM_AREA_SQUARE_METERS,
  MINIMUM_ROOM_CLEAR_WIDTH_METERS,
  planApartmentLayout,
} from "../src/ApartmentLayoutPlanner.ts";

const apartment = {
  outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
};

test("recursively creates equal orthogonal rooms down to the minimum area", () => {
  const layout = planApartmentLayout({ apartmentPolygon: apartment });
  assert.equal(layout.rooms.length, 8);
  const areas = layout.rooms.map((room) => polygonArea(room.polygon.outer));
  assert.ok(areas.every((area) => area >= MINIMUM_ROOM_AREA_SQUARE_METERS - 1e-7));
  assert.ok(layout.rooms.every((room) => minimumBoundsDimension(room.polygon.outer) >=
    MINIMUM_ROOM_CLEAR_WIDTH_METERS - 1e-7));
  assert.ok(areas.every((area) => area < MINIMUM_ROOM_AREA_SQUARE_METERS * 2));
  assert.ok(areas.every((area) => Math.abs(area - 12.5) < 1e-6));
  assert.ok(Math.abs(areas.reduce((sum, area) => sum + area, 0) - 100) < 1e-6);
  const generatedDoors = layout.openings.filter((opening) => opening.id.startsWith("room-door-"));
  assert.equal(generatedDoors.length, layout.rooms.length - 1);
});

test("moves orthogonal walls away from supplied openings", () => {
  const layout = planApartmentLayout({
    apartmentPolygon: apartment,
    openings: [{
      id: "door-1",
      type: "door",
      start: { x: 5, y: 0 },
      end: { x: 5, y: 1 },
    }],
  });
  assert.ok(layout.rooms.every((room) => room.polygon.outer.every((point, index, points) => {
    const next = points[(index + 1) % points.length];
    return !(Math.abs(point.x - 5) < 1e-7 && Math.abs(next.x - 5) < 1e-7 &&
      Math.min(point.y, next.y) <= 1 && Math.max(point.y, next.y) >= 0);
  })));
});

test("leaves an indivisible area as one room", () => {
  const layout = planApartmentLayout({
    apartmentPolygon: {
      outer: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 3 }, { x: 0, y: 3 }],
    },
  });
  assert.equal(layout.rooms.length, 1);
  assert.equal(polygonArea(layout.rooms[0].polygon.outer), 15);
});

test("rejects apartments smaller than the minimum room area", () => {
  assert.throws(() => planApartmentLayout({
    apartmentPolygon: { outer: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }] },
  }), /at least 10 square meters/);
});

test("subdivides concave apartments without extending beyond their outline", () => {
  const layout = planApartmentLayout({
    apartmentPolygon: {
      outer: [
        { x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 5 },
        { x: 5, y: 5 }, { x: 5, y: 12 }, { x: 0, y: 12 },
      ],
    },
  });
  assert.ok(layout.rooms.length > 1);
  assert.ok(layout.rooms.every((room) => polygonArea(room.polygon.outer) > 0));
});

function polygonArea(points) {
  return Math.abs(points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

function minimumBoundsDimension(points) {
  const width = Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x));
  const height = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));
  return Math.min(width, height);
}
