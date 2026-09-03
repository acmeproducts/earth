import assert from "node:assert/strict";
import test from "node:test";

const { planRoadsAndBuildings } = await import("../src/RoadAndBuildingPlanner.ts");
const { conformTerrainToPlannedFeatures } = await import("../src/PlannedFeatureTerrain.ts");

const appearance = {
  roadClass: "minor",
  widthMeters: 2,
  shoulderWidthMeters: 1,
  surface: "paved",
  visualStyle: "paved",
  structure: "surface",
  layer: 0,
  isTunnel: false,
};
const options = { meshWidth: 12, meshDepth: 12, metersPerUnit: 1 };

test("plans crossing roads as connected polygons without overlapping area", () => {
  const plan = planRoadsAndBuildings([
    { id: "east-west", paths: [[{ x: -5, z: 0 }, { x: 5, z: 0 }]], appearance },
    { id: "north-south", paths: [[{ x: 0, z: -5 }, { x: 0, z: 5 }]], appearance },
  ], [], options);

  assert.ok(plan.roads.length > 2);
  for (let left = 0; left < plan.roads.length; left++) {
    for (let right = left + 1; right < plan.roads.length; right++) {
      assert.equal(hasPositiveAreaIntersection(
        plan.roads[left].outline,
        plan.roads[right].outline,
      ), false);
    }
  }
  assert.ok(plan.roads.some((road) => pointInPolygon(0, 0, road.outline)));
  const junction = plan.roads.find((road) =>
    pointInPolygon(0, 0, road.outline) &&
    road.centerline[0].x === road.centerline[1].x &&
    road.centerline[0].z === road.centerline[1].z
  );
  assert.ok(junction, "the crossing should be owned by one level junction polygon");
  assert.ok(junction.outline.every((point) =>
    Math.hypot(point.x, point.z) <= appearance.widthMeters / 2 + 1e-8
  ), "the junction must not bulge beyond the widest connected carriageway");
  assert.ok(plan.roads.filter((road) => road.centerline.some((point) =>
    Math.hypot(point.x, point.z) < 1e-8
  )).length >= 5, "all four approaches should terminate at the shared junction");
});

test("joins a terminating road to another road without overlapping either surface", () => {
  const plan = planRoadsAndBuildings([
    { id: "through", paths: [[{ x: -5, z: 0 }, { x: 5, z: 0 }]], appearance },
    { id: "branch", paths: [[{ x: 0, z: 5 }, { x: 0, z: 0 }]], appearance },
  ], [], options);

  assertNoOverlappingRoadArea(plan.roads);
  assert.ok(plan.roads.some((road) => pointInPolygon(0, 0, road.outline)));
  assert.ok(plan.roads.filter((road) => road.centerline.some((point) =>
    Math.hypot(point.x, point.z) < 1e-8
  )).length >= 4, "all three approaches should meet the shared junction owner");
});

test("records clipped building-site polygons in the same construction plan", () => {
  const plan = planRoadsAndBuildings([], [{
    id: "building/1",
    outline: [
      { x: -8, z: -2 }, { x: 2, z: -2 }, { x: 2, z: 2 }, { x: -8, z: 2 },
    ],
  }], options);

  assert.equal(plan.buildingSites.length, 1);
  assert.equal(plan.buildingSites[0].sourceId, "building/1");
  assert.ok(plan.buildingSites[0].outline.every((point) => Math.abs(point.x) <= 6));
});

test("separates true overpasses while treating fords as ground-level roads", () => {
  const across = (id, overrides) => ({
    id,
    paths: [[{ x: 0, z: -5 }, { x: 0, z: 5 }]],
    appearance: { ...appearance, ...overrides },
  });
  const ground = { id: "ground", paths: [[{ x: -5, z: 0 }, { x: 5, z: 0 }]], appearance };
  const fordPlan = planRoadsAndBuildings([
    ground,
    across("ford", { visualStyle: "ford", structure: "ford" }),
  ], [], options);
  assertNoOverlappingRoadArea(fordPlan.roads);

  const bridgePlan = planRoadsAndBuildings([
    ground,
    across("bridge", { structure: "bridge", layer: 1 }),
  ], [], options);
  assert.ok(bridgePlan.roads.some((left, index) => bridgePlan.roads
    .slice(index + 1)
    .some((right) => hasPositiveAreaIntersection(left.outline, right.outline))));
});

test("grades roads across their width and building sites to one elevation in one pass", async () => {
  const width = 13;
  const height = 13;
  const elevations = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      elevations[row * width + column] = 20 + row * 2 + column * 0.25;
    }
  }
  const terrain = {
    elevations,
    minElevation: 20,
    maxElevation: 47,
    width,
    height,
    worldTile: { level: 16, x: 1, y: 1 },
    generationSeed: 1,
    groundWidthMeters: 12,
    groundHeightMeters: 12,
    bounds: { lonWest: 0, lonEast: 1, latNorth: 1, latSouth: 0 },
  };
  const plan = planRoadsAndBuildings([
    { id: "road", paths: [[{ x: -5, z: 0 }, { x: 5, z: 0 }]], appearance },
  ], [{
    id: "building",
    outline: [
      { x: -4, z: 3 }, { x: -2, z: 3 }, { x: -2, z: 5 }, { x: -4, z: 5 },
    ],
  }], options);

  await conformTerrainToPlannedFeatures(terrain, plan, options);
  // Exclude rounded dead-end caps: each cap intentionally holds its endpoint
  // elevation while the carriageway between them follows the longitudinal grade.
  for (let column = 3; column <= 9; column++) {
    assert.equal(terrain.elevations[5 * width + column], terrain.elevations[6 * width + column]);
    assert.equal(terrain.elevations[7 * width + column], terrain.elevations[6 * width + column]);
  }
  const buildingValues = [];
  for (let row = 1; row <= 3; row++) {
    for (let column = 2; column <= 4; column++) buildingValues.push(terrain.elevations[row * width + column]);
  }
  assert.equal(new Set(buildingValues).size, 1);
});

function pointInPolygon(x, z, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index];
    const b = points[previous];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function hasPositiveAreaIntersection(a, b) {
  for (const point of a) if (strictlyInsideConvex(point, b)) return true;
  for (const point of b) if (strictlyInsideConvex(point, a)) return true;
  for (let ai = 0; ai < a.length; ai++) {
    for (let bi = 0; bi < b.length; bi++) {
      if (properIntersection(a[ai], a[(ai + 1) % a.length], b[bi], b[(bi + 1) % b.length])) return true;
    }
  }
  return false;
}

function assertNoOverlappingRoadArea(roads) {
  for (let left = 0; left < roads.length; left++) {
    for (let right = left + 1; right < roads.length; right++) {
      assert.equal(hasPositiveAreaIntersection(roads[left].outline, roads[right].outline), false);
    }
  }
}

function strictlyInsideConvex(point, polygon) {
  let sign = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const value = (b.x - a.x) * (point.z - a.z) - (b.z - a.z) * (point.x - a.x);
    if (Math.abs(value) < 1e-7) return false;
    const edgeSign = Math.sign(value);
    if (sign && edgeSign !== sign) return false;
    sign = edgeSign;
  }
  return true;
}

function properIntersection(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  return cross(a, b, c) * cross(a, b, d) < -1e-9 && cross(c, d, a) * cross(c, d, b) < -1e-9;
}
