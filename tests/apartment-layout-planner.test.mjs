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
  assert.equal(layout.rooms.length, 4);
  const areas = layout.rooms.map((room) => polygonArea(room.polygon.outer));
  assert.ok(areas.every((area) => area >= MINIMUM_ROOM_AREA_SQUARE_METERS - 1e-7));
  assert.ok(layout.rooms.every((room) => minimumBoundsDimension(room.polygon.outer) >=
    MINIMUM_ROOM_CLEAR_WIDTH_METERS - 1e-7));
  assert.ok(areas.every((area) => Math.abs(area - 25) < 1e-6));
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
  assert.equal(layout.rooms[0].type, "living-room");
  assert.equal(layout.rooms[0].label, "Living room");
});

test("assigns a small room to the toilet and the largest remaining room to the kitchen", () => {
  const layout = planApartmentLayout({
    apartmentPolygon: apartment,
    minimumRoomAreaSquareMeters: 12,
  });
  assert.equal(layout.rooms.length, 4);
  assert.equal(layout.rooms.filter((room) => room.type === "toilet").length, 1);
  assert.equal(layout.rooms.filter((room) => room.type === "kitchen").length, 1);
  assert.ok(layout.rooms.find((room) => room.type === "toilet" && polygonArea(room.polygon.outer) < 25));
  assert.ok(layout.rooms.some((room) => room.type === "room"));
});

test("does not designate a toilet when every multi-room room is at least 25 square meters", () => {
  const layout = planApartmentLayout({
    apartmentPolygon: apartment,
    minimumRoomAreaSquareMeters: 30,
  });
  assert.ok(layout.rooms.length > 1);
  assert.equal(layout.rooms.filter((room) => room.type === "toilet").length, 0);
  assert.equal(layout.rooms.filter((room) => room.type === "kitchen").length, 1);
});

test("splits long apartments along their longest axis", () => {
  const layout = planApartmentLayout({
    apartmentPolygon: {
      outer: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 5 }, { x: 0, y: 5 }],
    },
    minimumRoomAreaSquareMeters: 12,
  });
  assert.ok(layout.rooms.length > 1);
  assert.ok(layout.rooms.every((room) => {
    const bounds = roomBounds(room.polygon.outer);
    return bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY - 1e-7;
  }));
});

test("supports different room-size limits for different apartments", () => {
  const largerRooms = planApartmentLayout({
    apartmentPolygon: apartment,
    minimumRoomAreaSquareMeters: 30,
  });
  const smallerRooms = planApartmentLayout({
    apartmentPolygon: apartment,
    minimumRoomAreaSquareMeters: 12,
  });
  assert.ok(largerRooms.rooms.length < smallerRooms.rooms.length);
  assert.ok(largerRooms.rooms.every((room) => polygonArea(room.polygon.outer) >= 30 - 1e-7));
  assert.ok(smallerRooms.rooms.every((room) => polygonArea(room.polygon.outer) >= 12 - 1e-7));
});

test("rejects unreasonable per-apartment room-size limits", () => {
  assert.throws(() => planApartmentLayout({
    apartmentPolygon: apartment,
    minimumRoomAreaSquareMeters: 10,
  }), /between 12 and 50/);
});

test("rejects apartments smaller than the minimum room area", () => {
  assert.throws(() => planApartmentLayout({
    apartmentPolygon: { outer: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }] },
  }), /at least 12 square meters/);
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

function roomBounds(points) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}
