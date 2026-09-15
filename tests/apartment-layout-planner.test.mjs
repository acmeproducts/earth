import assert from "node:assert/strict";
import test from "node:test";
import {
  MINIMUM_ROOM_AREA_SQUARE_METERS,
  MINIMUM_ROOM_CLEAR_WIDTH_METERS,
  assignApartmentRoomTypes,
  planApartmentLayout,
} from "../src/buildings/ApartmentLayoutPlanner.ts";

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

test("keeps longest-axis room splits balanced despite facade windows", () => {
  const layout = planApartmentLayout({
    apartmentPolygon: {
      outer: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 8 }, { x: 0, y: 8 }],
    },
    openings: [{
      id: "central-window",
      type: "window",
      start: { x: 6, y: 8 },
      end: { x: 14, y: 8 },
    }],
    minimumRoomAreaSquareMeters: 40,
  });
  assert.equal(layout.rooms.length, 4);
  assert.ok(layout.rooms.every((room) => Math.abs(polygonArea(room.polygon.outer) - 40) < 1e-6));
  assert.ok(layout.rooms.some((room) => room.polygon.outer.some((point, index, points) => {
    const next = points[(index + 1) % points.length];
    return Math.abs(point.x - 10) < 1e-7 && Math.abs(next.x - 10) < 1e-7 &&
      Math.min(point.y, next.y) < 1e-7 && Math.max(point.y, next.y) > 8 - 1e-7;
  })), "the first wall should bisect the apartment's long dimension");
});

test("balances the longest-axis split for an angled footprint", () => {
  const layout = planApartmentLayout({
    apartmentPolygon: {
      outer: [
        { x: 0, y: 0 }, { x: 14, y: 0 }, { x: 14, y: 4 },
        { x: 10, y: 8 }, { x: 0, y: 8 },
      ],
    },
    minimumRoomAreaSquareMeters: 45,
  });
  assert.equal(layout.rooms.length, 2);
  assert.ok(layout.rooms.every((room) => Math.abs(polygonArea(room.polygon.outer) - 52) < 1e-6));
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

test("splits a complete concave shell before decomposing its corners", () => {
  const layout = planApartmentLayout({
    apartmentPolygon: {
      outer: [
        { x: 0, y: 0 }, { x: 14, y: 0 }, { x: 14, y: 5 },
        { x: 5, y: 5 }, { x: 5, y: 12 }, { x: 0, y: 12 },
      ],
    },
    minimumRoomAreaSquareMeters: 20,
  });
  const equalCut = 52.5 / 12;
  const cutEdges = layout.rooms.flatMap((room) => room.polygon.outer.map((point, index, points) => [
    point,
    points[(index + 1) % points.length],
  ])).filter(([start, end]) =>
    Math.abs(start.x - equalCut) < 1e-6 && Math.abs(end.x - equalCut) < 1e-6);
  assert.ok(cutEdges.length >= 2, "the first wall should bisect the complete concave shell");
  assert.ok(Math.min(...cutEdges.flatMap(([start, end]) => [start.y, end.y])) < 1e-7);
  assert.ok(Math.max(...cutEdges.flatMap(([start, end]) => [start.y, end.y])) > 12 - 1e-7);
});

test("keeps room geometry and roles stable across equivalent polygon rings", () => {
  const rings = [];
  for (let shift = 0; shift < apartment.outer.length; shift++) {
    const rotated = [...apartment.outer.slice(shift), ...apartment.outer.slice(0, shift)];
    rings.push(rotated, [...rotated].reverse());
  }
  const signatures = rings.map((outer) => planApartmentLayout({
    apartmentPolygon: { outer },
    minimumRoomAreaSquareMeters: 12,
  }).rooms.map((room) => `${room.type}:${roomCenterKey(room.polygon.outer)}`).sort());
  for (const signature of signatures) assert.deepEqual(signature, signatures[0]);
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

function roomCenterKey(points) {
  const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  return `${x.toFixed(6)},${y.toFixed(6)}`;
}

test("a toilet is a dead end with exactly one door", () => {
  const apartments = [
    apartment,
    { outer: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 5 }, { x: 0, y: 5 }] },
    { outer: [{ x: 0, y: 0 }, { x: 14, y: 0 }, { x: 14, y: 9 }, { x: 0, y: 9 }] },
    { outer: [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 7 }, { x: 0, y: 7 }] },
  ];
  for (const polygon of apartments) {
    for (const minimumRoomAreaSquareMeters of [12, 14, 16, 20]) {
      const layout = planApartmentLayout({ apartmentPolygon: polygon, minimumRoomAreaSquareMeters });
      const toilet = layout.rooms.find((room) => room.type === "toilet");
      if (!toilet) continue;
      const doors = layout.openings.filter((opening) => opening.type === "door" &&
        segmentOnPolygon(opening, toilet.polygon.outer));
      assert.equal(doors.length, 1, `${JSON.stringify(polygon.outer)} @ ${minimumRoomAreaSquareMeters}`);
    }
  }
});

test("the room holding the entrance door never becomes the toilet", () => {
  // Four 5x5 rooms; the entrance sits on the wall of the bottom-left room.
  const layout = planApartmentLayout({
    apartmentPolygon: apartment,
    minimumRoomAreaSquareMeters: 12,
    openings: [{ id: "entrance", type: "door", start: { x: 1, y: 0 }, end: { x: 2, y: 0 } }],
  });
  const toilet = layout.rooms.find((room) => room.type === "toilet");
  assert.ok(toilet);
  const entrance = layout.openings.find((opening) => opening.id === "entrance");
  assert.ok(!segmentOnPolygon(entrance, toilet.polygon.outer));
  const toiletDoors = layout.openings.filter((opening) => opening.type === "door" &&
    segmentOnPolygon(opening, toilet.polygon.outer));
  assert.equal(toiletDoors.length, 1);
});

test("a room that other rooms can only be reached through never becomes the toilet", () => {
  // Three rooms in a row: the middle one is the smallest but is the only link
  // between the two ends, so it must not become the toilet.
  const rectangle = (minX, maxX) => ({
    outer: [{ x: minX, y: 0 }, { x: maxX, y: 0 }, { x: maxX, y: 4 }, { x: minX, y: 4 }],
  });
  const rooms = [
    { id: "room-1", type: "room", polygon: rectangle(0, 5) },
    { id: "room-2", type: "room", polygon: rectangle(5, 8) },
    { id: "room-3", type: "room", polygon: rectangle(8, 13) },
  ];
  assignApartmentRoomTypes(rooms);
  assert.notEqual(rooms[1].type, "toilet");
  assert.equal(rooms.filter((room) => room.type === "toilet").length, 1);
  assert.equal(rooms.filter((room) => room.type === "kitchen").length, 1);
});

function segmentOnPolygon(opening, points) {
  const middle = { x: (opening.start.x + opening.end.x) / 2, y: (opening.start.y + opening.end.y) / 2 };
  return points.some((a, index) => {
    const b = points[(index + 1) % points.length];
    const cross = (b.x - a.x) * (middle.y - a.y) - (b.y - a.y) * (middle.x - a.x);
    if (Math.abs(cross) > 1e-6) return false;
    return middle.x >= Math.min(a.x, b.x) - 1e-6 && middle.x <= Math.max(a.x, b.x) + 1e-6 &&
      middle.y >= Math.min(a.y, b.y) - 1e-6 && middle.y <= Math.max(a.y, b.y) + 1e-6;
  });
}
