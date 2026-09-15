import assert from "node:assert/strict";
import test from "node:test";
import { planBuildingLayout } from "../src/buildings/BuildingLayoutPlanner.ts";
import { renderFloorPlanSvg } from "../src/buildings/FloorPlan.ts";

const rectangle = {
  outer: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 12 }, { x: 0, y: 12 }],
};

test("plans apartments around a continuous hallway with adjacent stairs", () => {
  const layout = planBuildingLayout({
    buildingPolygon: rectangle,
    buildingType: "apartment-building",
  });
  assert.ok(layout.rooms.filter((room) => room.type === "apartment").length >= 3);
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

test("preserves courtyard holes while planning apartment shells", () => {
  const hole = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }];
  const layout = planBuildingLayout({
    buildingPolygon: { ...rectangle, holes: [hole] }, buildingType: "apartment-building",
  });
  assert.equal(layout.boundary.holes.length, 1);
  assert.ok(Math.abs(layout.rooms.reduce((sum, room) => sum + polygonArea(room.polygon.outer), 0) -
    (polygonArea(rectangle.outer) - polygonArea(hole))) < 1e-6);
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
  assert.ok(layout.openings.some((opening) => opening.id === "entrance-lobby-door"),
    "the entrance lobby should open into the main hallway");
  const stairs = polygonBounds(layout.rooms.find((room) => room.type === "stairs").polygon.outer);
  assert.ok(stairs.maxX < 13 - 1e-7 || stairs.minX > 15 + 1e-7);
  assert.equal(
    layout.openings.filter((opening) => opening.id.startsWith("apartment-")).length,
    layout.rooms.filter((room) => room.type === "apartment").length,
  );
});

test("does not emit undersized apartments beside an off-center entrance", () => {
  const layout = planBuildingLayout({
    buildingPolygon: {
      outer: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 12 }, { x: 0, y: 12 }],
    },
    buildingType: "apartment-building",
    openings: [{
      id: "front-door",
      type: "door",
      start: { x: 1.6, y: 0 },
      end: { x: 2.4, y: 0 },
    }],
  });
  assert.ok(layout.rooms.filter((room) => room.type === "apartment").every(
    (room) => polygonArea(room.polygon.outer) >= 24 - 1e-7,
  ));
  assert.ok(layout.rooms.some((room) => room.id.startsWith("common-area-")));
  assert.ok(Math.abs(layout.rooms.reduce(
    (area, room) => area + polygonArea(room.polygon.outer), 0,
  ) - 240) < 1e-6);
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
  assert.ok(layout.rooms.filter((room) => room.type === "apartment").every((room) =>
    polygonArea(room.polygon.outer) <= 120 + 1e-7));
  assert.ok(layout.openings.some((opening) => opening.id.endsWith("-door")));
  const entrance = { x: 2.6, y: 0 };
  assert.ok(layout.rooms.filter((room) => room.type === "hallway").some((hallway) =>
    hallway.polygon.outer.some((point, index, points) =>
      pointOnSegment(entrance, point, points[(index + 1) % points.length]))),
  "the exterior entry should lead into the shared hallway");
});

test("keeps captured concave apartments below the maximum area", () => {
  const capturedOutlines = [
    [
      { x: -155.9395034421023, y: -148.67113665761795 },
      { x: -122.43687574946314, y: -115.73635013141448 },
      { x: -130.05110931597204, y: -107.8175472317824 },
      { x: -127.30998523202884, y: -105.38099249004478 },
      { x: -134.61964945587738, y: -98.07132827061032 },
      { x: -124.56886114808563, y: -88.32510931088284 },
      { x: -130.66024800129276, y: -82.5382918078334 },
      { x: -155.9395034421023, y: -107.33756136927036 },
    ],
    [
      { x: -70.35551815454225, y: -57.868175064804355 },
      { x: -63.65499261601442, y: -60.913868491073536 },
      { x: -67.00525538527833, y: -67.91896336824219 },
      { x: -68.83267144124046, y: -67.00525534216726 },
      { x: -73.09664223848546, y: -76.75147429828313 },
      { x: -69.74637946922154, y: -78.27432101250118 },
      { x: -72.48750355316474, y: -84.6702772022491 },
      { x: -63.35042327335406, y: -88.62967865531554 },
      { x: -50.25394153895875, y: -60.00016046499856 },
      { x: -53.60420430822266, y: -58.47731375222512 },
      { x: -50.55851088161911, y: -51.47221887577874 },
      { x: -64.56870064399548, y: -45.07626268169696 },
    ],
  ];

  for (const outer of capturedOutlines) {
    const layout = planBuildingLayout({
      buildingPolygon: { outer },
      buildingType: "house",
    });
    assert.ok(layout.rooms.filter((room) => room.type === "apartment").every((room) =>
      polygonArea(room.polygon.outer) <= 120 + 1e-7));
    assert.ok(layout.rooms.filter((room) => room.type === "apartment").every((room) =>
      polygonCompactness(room.polygon.outer) >= 0.35),
    "captured apartments should not collapse into long or bridged strips");
    assert.ok(layout.rooms.filter((room) => room.type === "apartment").every((room) =>
      layout.openings.some((opening) => openingTouchesPolygon(opening, room.polygon.outer))));
    assert.ok(layout.rooms.some((room) => room.type === "stairs"));
  }
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

function polygonCompactness(points) {
  const perimeter = points.reduce((length, point, index) => {
    const next = points[(index + 1) % points.length];
    return length + Math.hypot(next.x - point.x, next.y - point.y);
  }, 0);
  return 4 * Math.PI * polygonArea(points) / (perimeter * perimeter);
}

function openingTouchesPolygon(opening, polygon) {
  const center = {
    x: (opening.start.x + opening.end.x) / 2,
    y: (opening.start.y + opening.end.y) / 2,
  };
  return polygon.some((start, index) =>
    pointOnSegment(center, start, polygon[(index + 1) % polygon.length]));
}
