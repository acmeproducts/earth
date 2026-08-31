import assert from "node:assert/strict";
import test from "node:test";
import { planBuildingLayout } from "../src/BuildingLayoutPlanner.ts";
import { renderFloorPlanSvg } from "../src/FloorPlan.ts";

const rectangle = {
  outer: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 12 }, { x: 0, y: 12 }],
};

test("plans apartments around a continuous hallway with adjacent stairs", () => {
  const layout = planBuildingLayout({
    buildingPolygon: rectangle,
    buildingType: "apartment-building",
  });
  assert.equal(layout.rooms.filter((room) => room.type === "apartment").length, 3);
  assert.equal(layout.rooms.filter((room) => room.type === "hallway").length, 1);
  assert.equal(layout.rooms.filter((room) => room.type === "stairs").length, 1);
  assert.ok(layout.rooms.every((room) => room.polygon.outer.length >= 3));
  const hallway = polygonBounds(layout.rooms.find((room) => room.type === "hallway").polygon.outer);
  const stairs = polygonBounds(layout.rooms.find((room) => room.type === "stairs").polygon.outer);
  assert.ok(stairs.maxY <= hallway.minY + 1e-7);
});

test("treats a house as one shell for the separate apartment planner", () => {
  const layout = planBuildingLayout({
    buildingPolygon: {
      outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    },
    buildingType: "house",
  });
  assert.deepEqual(layout.rooms.map((room) => room.type), ["apartment"]);
  assert.equal(layout.rooms[0].polygon, layout.boundary);
});

test("clips proposed rooms to a convex non-rectangular footprint", () => {
  const layout = planBuildingLayout({
    buildingPolygon: {
      outer: [{ x: 0, y: 2 }, { x: 4, y: 0 }, { x: 20, y: 0 }, { x: 24, y: 6 }, { x: 20, y: 12 }, { x: 4, y: 12 }],
    },
    buildingType: "apartment-building",
  });
  assert.ok(layout.rooms.length > 0);
  assert.ok(layout.rooms.flatMap((room) => room.polygon.outer).every(
    (point) => point.x >= 0 && point.x <= 24 && point.y >= 0 && point.y <= 12,
  ));
  assert.ok(Math.abs(layout.rooms.reduce(
    (area, room) => area + polygonArea(room.polygon.outer), 0,
  ) - polygonArea(layout.boundary.outer)) < 1e-6);
});

test("renders any polygon layout as a standalone labeled SVG", () => {
  const layout = planBuildingLayout({
    buildingPolygon: rectangle,
    buildingType: "apartment-building",
    openings: [
      { id: "front-door", type: "door", start: { x: 9, y: 0 }, end: { x: 11, y: 0 } },
      { id: "window-1", type: "window", start: { x: 2, y: 12 }, end: { x: 5, y: 12 } },
    ],
  });
  const svg = renderFloorPlanSvg(layout, { width: 640, height: 400 });
  assert.match(svg, /^<svg/);
  assert.match(svg, /width="640" height="400"/);
  assert.match(svg, /data-room-type="apartment"/);
  assert.match(svg, /data-room-type="hallway"/);
  assert.match(svg, /data-opening-type="door"/);
  assert.match(svg, /data-opening-type="window"/);
  assert.match(svg, /aria-label="Floor plan"/);
});

test("rejects geometry outside the initial planner's documented scope", () => {
  assert.throws(
    () => planBuildingLayout({
      buildingPolygon: { ...rectangle, holes: [[{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }]] },
      buildingType: "apartment-building",
    }),
    /does not support polygon holes/,
  );
});

test("only adds common circulation above the 120 square meter threshold", () => {
  const small = planBuildingLayout({
    buildingPolygon: { outer: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 10 }, { x: 0, y: 10 }] },
    buildingType: "apartment-building",
  });
  const large = planBuildingLayout({ buildingPolygon: rectangle, buildingType: "house" });
  assert.deepEqual(small.rooms.map((room) => room.type), ["apartment"]);
  assert.ok(large.rooms.some((room) => room.type === "hallway"));
  assert.ok(large.rooms.some((room) => room.type === "stairs"));
  assert.ok(large.rooms.filter((room) => room.type === "apartment").every(
    (room) => polygonArea(room.polygon.outer) <= 120 + 1e-7,
  ));
  assert.ok(Math.abs(large.rooms.reduce(
    (area, room) => area + polygonArea(room.polygon.outer), 0,
  ) - polygonArea(rectangle.outer)) < 1e-6);
});

test("does not place an apartment wall in front of an exterior door", () => {
  const layout = planBuildingLayout({
    buildingPolygon: {
      outer: [{ x: 0, y: 0 }, { x: 28, y: 0 }, { x: 28, y: 14 }, { x: 0, y: 14 }],
    },
    buildingType: "apartment-building",
    openings: [{
      id: "front-door",
      type: "door",
      start: { x: 13, y: 0 },
      end: { x: 15, y: 0 },
    }],
  });
  assert.ok(layout.rooms.every((room) => room.polygon.outer.every((point, index, points) => {
    const next = points[(index + 1) % points.length];
    if (Math.abs(point.x - next.x) > 1e-7) return true;
    const reachesDoor = Math.min(point.y, next.y) <= 0 && Math.max(point.y, next.y) >= 0;
    return !reachesDoor || point.x < 13 - 1e-7 || point.x > 15 + 1e-7;
  })));
  assert.ok(layout.rooms.some((room) => room.id === "entrance-lobby"));
  const stairs = polygonBounds(layout.rooms.find((room) => room.type === "stairs").polygon.outer);
  assert.ok(stairs.maxX < 13 - 1e-7 || stairs.minX > 15 + 1e-7);
  assert.equal(
    layout.openings.filter((opening) => opening.id.startsWith("apartment-")).length,
    layout.rooms.filter((room) => room.type === "apartment").length,
  );
});

test("keeps the stair core aligned for matching upper floors", () => {
  const input = { buildingPolygon: rectangle, buildingType: "apartment-building" };
  const first = planBuildingLayout(input);
  const nextFloor = planBuildingLayout(input);
  assert.deepEqual(
    first.rooms.find((room) => room.type === "stairs").polygon,
    nextFloor.rooms.find((room) => room.type === "stairs").polygon,
  );
});

test("plans a concave footprint instead of discarding its interior", () => {
  const layout = planBuildingLayout({
    buildingType: "house",
    buildingPolygon: {
      outer: [
        { x: 0, y: 0 }, { x: 22, y: 0 }, { x: 22, y: 8 },
        { x: 10, y: 8 }, { x: 10, y: 18 }, { x: 0, y: 18 },
      ],
    },
    openings: [{ id: "door", type: "door", start: { x: 2, y: 0 }, end: { x: 3.2, y: 0 } }],
  });
  assert.ok(layout.rooms.length > 1);
  assert.ok(layout.rooms.some((room) => room.type === "hallway"));
  assert.ok(layout.rooms.some((room) => room.type === "apartment"));
  assert.ok(layout.openings.some((opening) => opening.id.endsWith("-door")));
  const hallway = layout.rooms.find((room) => room.type === "hallway");
  const entrance = { x: 2.6, y: 0 };
  assert.ok(hallway.polygon.outer.some((point, index, points) =>
    pointOnSegment(entrance, point, points[(index + 1) % points.length])),
  "the exterior entry should lead into the shared hallway");
});

function polygonArea(points) {
  return Math.abs(points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

function polygonBounds(points) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function pointOnSegment(point, start, end) {
  const cross = (point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x);
  if (Math.abs(cross) > 1e-7) return false;
  return point.x >= Math.min(start.x, end.x) - 1e-7 && point.x <= Math.max(start.x, end.x) + 1e-7 &&
    point.y >= Math.min(start.y, end.y) - 1e-7 && point.y <= Math.max(start.y, end.y) + 1e-7;
}
