import assert from "node:assert/strict";
import test from "node:test";

const { planRoadsAndBuildings } = await import("../src/roads/RoadAndBuildingPlanner.ts");
const { conformTerrainToPlannedFeatures } = await import("../src/terrain/PlannedFeatureTerrain.ts");

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

test("planner records each synchronous phase without a caller trace", async () => {
  const { streamingDiagnosticsSnapshot } = await import("../src/diagnostics/StreamingDiagnostics.ts");
  const before = Math.max(0, ...streamingDiagnosticsSnapshot().stages.map((entry) => entry.traceId));
  planRoadsAndBuildings([], [], options);
  const entries = streamingDiagnosticsSnapshot().stages.filter((entry) => entry.traceId > before);
  assert.deepEqual(entries.map((entry) => entry.stage), [
    "planner road network construction",
    "planner road triangulation", "planner road partitioning", "planner road merging",
    "planner shoulder triangulation", "planner shoulder partitioning", "planner shoulder merging",
    "planner building clipping", "planner street lamps", "planner building plots", "planner plot boundaries",
  ]);
  assert.ok(entries.every((entry) => entry.completed && entry.timingKind === "synchronous"));
  assert.equal(streamingDiagnosticsSnapshot().activeStages.length, 0);
});

test("plans crossing roads as connected polygons without overlapping area", () => {
  const plan = planRoadsAndBuildings([
    { id: "east-west", paths: [[{ x: -5, z: 0 }, { x: 5, z: 0 }]], appearance },
    { id: "north-south", paths: [[{ x: 0, z: -5 }, { x: 0, z: 5 }]], appearance },
  ], [], options);

  assert.ok(plan.roads.length > 2);
  assert.ok(plan.roads.length <= 9, `expected a junction and approaches, got ${plan.roads.length} polygons`);
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

test("places street lamps near buildings just beyond lit road beds and respects nearby mapped lamps", () => {
  const wideOptions = { meshWidth: 200, meshDepth: 200, metersPerUnit: 1 };
  const plan = planRoadsAndBuildings([
    { id: "avenue", paths: [[{ x: -90, z: 0 }, { x: 90, z: 0 }]], appearance },
    {
      id: "trail",
      paths: [[{ x: -90, z: 60 }, { x: 90, z: 60 }]],
      appearance: { ...appearance, roadClass: "path" },
    },
  ], [{ id: "frontage", outline: [
    { x: -90, z: 10 }, { x: 90, z: 10 }, { x: 90, z: 20 }, { x: -90, z: 20 },
  ] }], wideOptions, [
    { id: "lamp/far", position: { x: 0, z: -80 } },
    { id: "lamp/roadside", position: { x: 0, z: 2.7 } },
    { id: "lamp/outside", position: { x: 500, z: 0 } },
  ]);

  const mapped = plan.streetLamps.filter((lamp) => lamp.source === "mapped");
  assert.deepEqual(mapped.map((lamp) => lamp.sourceId), ["lamp/roadside"]);
  const procedural = plan.streetLamps.filter((lamp) => lamp.source === "procedural");
  assert.ok(procedural.length >= 4, `expected roadside infill, got ${procedural.length}`);
  const offset = appearance.widthMeters / 2 + appearance.shoulderWidthMeters + 0.7;
  const sides = new Set();
  for (const lamp of procedural) {
    assert.equal(lamp.sourceId, "avenue", "unlit road classes must not receive lamps");
    assert.ok(Math.abs(Math.abs(lamp.position.z) - offset) < 1e-6,
      "lamps must stand just beyond the planned road bed");
    assert.ok(Math.hypot(lamp.position.x, lamp.position.z - 2.7) >= 25 - 1e-6,
      "procedural lamps must keep clear of mapped lamps");
    sides.add(Math.sign(lamp.position.z));
  }
  assert.equal(sides.size, 2, "lamps should alternate road sides");
});

test("keeps procedural lamps off every planned road bed, including crossing roads", () => {
  const wideOptions = { meshWidth: 200, meshDepth: 200, metersPerUnit: 1 };
  const wide = { ...appearance, widthMeters: 12, shoulderWidthMeters: 2 };
  const plan = planRoadsAndBuildings([
    { id: "east-west", paths: [[{ x: -90, z: 0 }, { x: 90, z: 0 }]], appearance: wide },
    { id: "north-south", paths: [[{ x: 0, z: -90 }, { x: 0, z: 90 }]], appearance: wide },
    { id: "diagonal", paths: [[{ x: -90, z: -90 }, { x: 90, z: 90 }]], appearance: wide },
  ], [-65, 0, 65].flatMap((x) => [-65, 0, 65].map((z) => ({
    id: `building/${x}/${z}`,
    outline: [{ x, z }, { x: x + 6, z }, { x: x + 6, z: z + 6 }, { x, z: z + 6 }],
  }))), wideOptions);

  const procedural = plan.streetLamps.filter((lamp) => lamp.source === "procedural");
  assert.ok(procedural.length >= 6);
  for (const lamp of procedural) {
    for (const bed of [...plan.roads, ...plan.shoulders]) {
      assert.equal(pointInPolygon(lamp.position.x, lamp.position.z, bed.outline), false,
        `lamp from ${lamp.sourceId} at ${lamp.position.x},${lamp.position.z} stands on a road bed`);
    }
  }
});

test("omits all street lamps when no buildings are nearby", () => {
  const roads = [{ id: "rural", paths: [[{ x: -150, z: 0 }, { x: 150, z: 0 }]], appearance }];
  const wideOptions = { meshWidth: 400, meshDepth: 400, metersPerUnit: 1 };
  const mapped = [{ id: "mapped", position: { x: 0, z: 3 } }];
  assert.deepEqual(planRoadsAndBuildings(roads, [], wideOptions, mapped).streetLamps, []);
  const remote = [{ id: "remote", outline: [
    { x: -5, z: 100 }, { x: 5, z: 100 }, { x: 5, z: 110 }, { x: -5, z: 110 },
  ] }];
  assert.deepEqual(planRoadsAndBuildings(roads, remote, wideOptions, mapped).streetLamps, []);
});

test("limits lamps along a partly developed road by footprint distance at different scene scales", () => {
  for (const metersPerUnit of [1, 5]) {
    const point = (x, z) => ({ x: x / metersPerUnit, z: z / metersPerUnit });
    const plan = planRoadsAndBuildings([
      { id: "long-road", paths: [[point(-180, 0), point(180, 0)]], appearance },
    ], [{ id: "building", outline: [point(-10, 10), point(10, 10), point(10, 20), point(-10, 20)] }],
    { meshWidth: 400 / metersPerUnit, meshDepth: 400 / metersPerUnit, metersPerUnit }, [
      { id: "at-limit", position: point(60, 15) },
      { id: "past-limit", position: point(60.1, 15) },
      { id: "diagonal-far", position: point(55, 60) },
    ]);
    assert.deepEqual(plan.streetLamps.filter((lamp) => lamp.source === "mapped").map((lamp) => lamp.sourceId), ["at-limit"]);
    const procedural = plan.streetLamps.filter((lamp) => lamp.source === "procedural");
    assert.ok(procedural.length > 0);
    for (const lamp of procedural) {
      const x = lamp.position.x * metersPerUnit;
      const z = lamp.position.z * metersPerUnit;
      assert.ok(Math.hypot(Math.max(0, Math.abs(x) - 10), 10 - z) <= 50);
    }
  }
});

test("designates building plots that attach to road beds and to each other", () => {
  const wideOptions = { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 };
  const plan = planRoadsAndBuildings([
    { id: "street", paths: [[{ x: -45, z: 0 }, { x: 45, z: 0 }]], appearance },
  ], [
    { id: "west", outline: [{ x: -12, z: 6 }, { x: -4, z: 6 }, { x: -4, z: 12 }, { x: -12, z: 12 }] },
    { id: "east", outline: [{ x: 4, z: 6 }, { x: 12, z: 6 }, { x: 12, z: 12 }, { x: 4, z: 12 }] },
  ], wideOptions);

  assert.deepEqual(plan.plots.map((plot) => plot.sourceId).sort(), ["east", "west"]);
  const west = plan.plots.find((plot) => plot.sourceId === "west");
  const east = plan.plots.find((plot) => plot.sourceId === "east");
  assert.ok(pointInPolygon(-8, 9, west.outline), "a plot must contain its building");
  assert.ok(pointInPolygon(8, 9, east.outline), "a plot must contain its building");
  assert.equal(hasPositiveAreaIntersection(west.outline, east.outline), false);
  for (const plot of plan.plots) {
    for (const road of [...plan.roads, ...plan.shoulders]) {
      assert.equal(hasPositiveAreaIntersection(plot.outline, road.outline), false,
        `plot ${plot.sourceId} must not cover the road bed`);
    }
  }
  const roadBedEdge = appearance.widthMeters / 2 + appearance.shoulderWidthMeters;
  assert.ok(Math.abs(Math.min(...west.outline.map((point) => point.z)) - roadBedEdge) < 1e-6,
    "plots must butt flush against the road bed");
  assert.ok(Math.abs(Math.max(...west.outline.map((point) => point.x))) < 1e-6,
    "neighboring plots must meet on their shared bisector");
  assert.ok(Math.abs(Math.min(...east.outline.map((point) => point.x))) < 1e-6,
    "neighboring plots must meet on their shared bisector");
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

test("gently grades roads after leveling building sites", async () => {
  const width = 13;
  const height = 13;
  const elevations = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      elevations[row * width + column] = 20 + row * 0.5 + column * 0.25;
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
  // The road blend can reshape the near edge of a pad; its far edge stays level.
  for (let column = 2; column <= 4; column++) buildingValues.push(terrain.elevations[column]);
  assert.equal(new Set(buildingValues).size, 1);
});

test("selectively plans plot hedges and fences with road entrance gaps", () => {
  const wideOptions = { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 };
  const buildings = Array.from({ length: 12 }, (_, index) => ({
    id: `house-${index}`,
    outline: [
      { x: -44 + index * 8, z: 7 },
      { x: -39 + index * 8, z: 7 },
      { x: -39 + index * 8, z: 13 },
      { x: -44 + index * 8, z: 13 },
    ],
  }));
  const inputs = [
    { id: "street", paths: [[{ x: -49, z: 0 }, { x: 49, z: 0 }]], appearance },
  ];
  const plan = planRoadsAndBuildings(inputs, buildings, wideOptions);
  const repeated = planRoadsAndBuildings(inputs, buildings, wideOptions);

  assert.deepEqual(plan.plotBoundaries, repeated.plotBoundaries,
    "plot boundary selection must be reproducible");
  const treatedPlots = new Set(plan.plotBoundaries.map((boundary) => boundary.sourceId));
  assert.ok(treatedPlots.size > 0 && treatedPlots.size < buildings.length,
    "only a subset of plots should receive boundaries");
  assert.ok(plan.plotBoundaries.some((boundary) => boundary.style === "hedge"));
  assert.ok(plan.plotBoundaries.some((boundary) => boundary.style === "woodFence"));

  for (const boundary of plan.plotBoundaries) {
    const [start, end] = boundary.path;
    const onTileEdge = (start.x === -50 && end.x === -50) ||
      (start.x === 50 && end.x === 50) ||
      (start.z === -50 && end.z === -50) ||
      (start.z === 50 && end.z === 50);
    assert.equal(onTileEdge, false, "tile clipping edges are not parcel boundaries");
    for (let step = 0; step <= 8; step++) {
      const amount = step / 8;
      const point = {
        x: start.x + (end.x - start.x) * amount,
        z: start.z + (end.z - start.z) * amount,
      };
      for (const building of buildings) {
        assert.ok(distanceToPolygonEdge(point, building.outline) >= 2.5 - 1e-6,
          `boundary for ${boundary.sourceId} must stand clear of ${building.id}`);
      }
    }
  }

  const roadBedEdge = appearance.widthMeters / 2 + appearance.shoulderWidthMeters;
  const frontages = plan.plotBoundaries.filter((boundary) =>
    Math.abs(boundary.path[0].z - roadBedEdge) < 1e-6 &&
    Math.abs(boundary.path[1].z - roadBedEdge) < 1e-6
  );
  const entranceFound = frontages.some((left, index) => frontages.slice(index + 1).some((right) => {
    if (left.sourceId !== right.sourceId) return false;
    const leftEnds = left.path.map((point) => point.x).sort((a, b) => a - b);
    const rightEnds = right.path.map((point) => point.x).sort((a, b) => a - b);
    const gap = leftEnds[1] <= rightEnds[0]
      ? rightEnds[0] - leftEnds[1]
      : rightEnds[1] <= leftEnds[0]
        ? leftEnds[0] - rightEnds[1]
        : 0;
    return Math.abs(gap - 3.2) < 1e-6;
  }));
  assert.ok(entranceFound, "a treated road frontage should retain a driveway-sized gap");
});

test("leaves isolated plots open toward nature, including beneath bridges", () => {
  for (let index = 0; index < 20; index++) {
    const buildings = [{
      id: `house-${index}`,
      outline: [{ x: -4, z: 7 }, { x: 4, z: 7 }, { x: 4, z: 13 }, { x: -4, z: 13 }],
    }];
    const wideOptions = { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 };
    for (const roads of [[], [{
      id: "bridge",
      paths: [[{ x: -45, z: 0 }, { x: 45, z: 0 }]],
      appearance: { ...appearance, structure: "bridge", layer: 1 },
    }]]) {
      const plan = planRoadsAndBuildings(roads, buildings, wideOptions);
      assert.equal(plan.plots.length, 1);
      assert.deepEqual(plan.plotBoundaries, [], "open land is not evidence of a boundary");
    }
  }
});

test("treats only the shared portion of unequal neighboring plot edges at any scene scale", () => {
  for (const metersPerUnit of [1, 5]) {
    let count = 0;
    for (let index = 0; index < 20; index++) {
      const rectangle = (minX, maxX, minZ, maxZ) => [
        { x: minX, z: minZ }, { x: maxX, z: minZ },
        { x: maxX, z: maxZ }, { x: minX, z: maxZ },
      ].map(({ x, z }) => ({ x: x / metersPerUnit, z: z / metersPerUnit }));
      const plan = planRoadsAndBuildings([], [
        { id: `house-${index}`, outline: rectangle(-12, -4, 0, 6) },
        { id: `neighbor-${index}`, outline: rectangle(4, 12, 2, 4) },
      ], { meshWidth: 100 / metersPerUnit, meshDepth: 100 / metersPerUnit, metersPerUnit });
      count += plan.plotBoundaries.length;
      assert.ok(plan.plotBoundaries.length <= 1, "shared contact is rendered only once");
      for (const boundary of plan.plotBoundaries) {
        for (const point of boundary.path) {
          assert.ok(Math.abs(point.x) < 1e-6, "only the neighbor-facing side is treated");
          assert.ok(point.z * metersPerUnit >= -10 - 1e-6 && point.z * metersPerUnit <= 16 + 1e-6,
            "barriers stop at the end of the shorter neighboring plot");
        }
      }
    }
    assert.ok(count > 0, "neighbor contacts should receive barriers");
  }
});

test("reuses one building pad elevation across independently processed tiles", async () => {
  const sharedBuildingElevations = new Map();
  const makeTerrain = (fill, x) => ({
    elevations: new Float32Array(25).fill(fill),
    minElevation: fill,
    maxElevation: fill,
    width: 5,
    height: 5,
    worldTile: { level: 16, x, y: 1 },
    generationSeed: 1,
    groundWidthMeters: 4,
    groundHeightMeters: 4,
    bounds: { lonWest: x, lonEast: x + 1, latNorth: 1, latSouth: 0 },
  });
  const plan = planRoadsAndBuildings([], [{
    id: "cross-boundary-building",
    outline: [
      { x: -1, z: -1 }, { x: 1, z: -1 }, { x: 1, z: 1 }, { x: -1, z: 1 },
    ],
  }], { meshWidth: 4, meshDepth: 4, metersPerUnit: 1 });
  const first = makeTerrain(10, 1);
  const second = makeTerrain(30, 2);
  const options = {
    meshWidth: 4,
    meshDepth: 4,
    metersPerUnit: 1,
    sharedBuildingElevations,
  };

  await conformTerrainToPlannedFeatures(first, plan, options);
  await conformTerrainToPlannedFeatures(second, plan, options);

  assert.equal(sharedBuildingElevations.get("cross-boundary-building"), 10);
  assert.equal(first.elevations[12], 10);
  assert.equal(second.elevations[12], 10);
});

test("neighboring building pads cannot raise terrain through a lower floor", async () => {
  for (const metersPerUnit of [1, 5]) {
    for (const reverse of [false, true]) {
      const rectangle = (minX, maxX) => [
        { x: minX, z: -1 }, { x: maxX, z: -1 },
        { x: maxX, z: 1 }, { x: minX, z: 1 },
      ].map(({ x, z }) => ({ x: x / metersPerUnit, z: z / metersPerUnit }));
      const buildings = [
        { id: "lower", outline: rectangle(-2, 0) },
        { id: "higher", outline: rectangle(1, 3) },
      ];
      if (reverse) buildings.reverse();
      const opts = {
        meshWidth: 12 / metersPerUnit, meshDepth: 12 / metersPerUnit, metersPerUnit,
        sharedBuildingElevations: new Map([["lower", 10], ["higher", 20]]),
      };
      const terrain = gradingTerrain(13, 15);
      await conformTerrainToPlannedFeatures(terrain, planRoadsAndBuildings([], buildings, opts), opts);
      for (let row = 5; row <= 7; row++) {
        for (let column = 4; column <= 6; column++) {
          assert.equal(terrain.elevations[row * 13 + column], 10);
        }
      }
    }
  }
});

test("road grading takes priority over overlapping building support samples", async () => {
  const opts = { ...options, sharedBuildingElevations: new Map([["house", 10]]) };
  const terrain = gradingTerrain(13, 30);
  const plan = planRoadsAndBuildings([
    { id: "street", paths: [[{ x: -5, z: 0 }, { x: 5, z: 0 }]], appearance },
  ], [{ id: "house", outline: [
    { x: -1, z: 0.8 }, { x: 1, z: 0.8 }, { x: 1, z: 2 }, { x: -1, z: 2 },
  ] }], opts);
  await conformTerrainToPlannedFeatures(terrain, plan, opts);
  for (let row = 4; row <= 6; row++) {
    for (let column = 5; column <= 7; column++) {
      assert.equal(terrain.elevations[row * 13 + column], 30);
    }
  }
});

test("road beds stay flat beside raised building pads at different scene scales", async () => {
  for (const metersPerUnit of [1, 5]) {
    const opts = {
      meshWidth: 12 / metersPerUnit, meshDepth: 12 / metersPerUnit, metersPerUnit,
      sharedBuildingElevations: new Map([["house", 40]]),
    };
    const point = (x, z) => ({ x: x / metersPerUnit, z: z / metersPerUnit });
    const buildings = [{ id: "house", outline: [
      point(-1, 2), point(1, 2), point(1, 5), point(-1, 5),
    ] }];
    const terrain = gradingTerrain(13, 20);
    const buildingOnly = gradingTerrain(13, 20);
    await conformTerrainToPlannedFeatures(buildingOnly, planRoadsAndBuildings([], buildings, opts), opts);
    assert.ok(buildingOnly.elevations[5 * 13 + 6] > 21,
      "the building pad must raise the nearby road bed beyond the natural earthwork limit");
    const plan = planRoadsAndBuildings([
      { id: "street", paths: [[point(-5, 0), point(5, 0)]], appearance },
    ], buildings, opts);
    await conformTerrainToPlannedFeatures(terrain, plan, opts);
    for (let row = 5; row <= 7; row++) {
      for (let column = 2; column <= 10; column++) {
        assert.equal(terrain.elevations[row * 13 + column], 20);
      }
    }
    assert.equal(terrain.elevations[6], 40,
      "the building pad stays level beyond the road blend");
    assert.equal(terrain.minElevation, Math.min(...terrain.elevations));
    assert.equal(terrain.maxElevation, Math.max(...terrain.elevations));
  }
});

test("the final road pass fills deep dips beside buildings across the bed and shoulders", async () => {
  for (const metersPerUnit of [1, 5]) {
    const opts = {
      meshWidth: 12 / metersPerUnit, meshDepth: 12 / metersPerUnit, metersPerUnit,
      sharedBuildingElevations: new Map([["house", 12]]),
    };
    const point = (x, z) => ({ x: x / metersPerUnit, z: z / metersPerUnit });
    const terrain = gradingTerrain(13, 20);
    for (let row = 4; row <= 8; row++) {
      for (let column = 4; column <= 8; column++) terrain.elevations[row * 13 + column] = 10;
    }
    const plan = planRoadsAndBuildings([
      { id: "street", paths: [[point(-5, 0), point(5, 0)]], appearance },
    ], [{ id: "house", outline: [point(-1, 3), point(1, 3), point(1, 5), point(-1, 5)] }], opts);
    await conformTerrainToPlannedFeatures(terrain, plan, opts);
    for (let row = 4; row <= 8; row++) {
      for (let column = 4; column <= 8; column++) {
        assert.equal(terrain.elevations[row * 13 + column], 20,
          "the ground must rise to the road grade after building leveling");
      }
    }
  }
});

test("a small footprint protects the diagonally opposite raster cell corner", async () => {
  const opts = { ...options, sharedBuildingElevations: new Map([["small", 10]]) };
  const terrain = gradingTerrain(7, 100);
  const plan = planRoadsAndBuildings([], [{ id: "small", outline: [
    { x: 0.01, z: 0.01 }, { x: 0.1, z: 0.01 },
    { x: 0.1, z: 0.1 }, { x: 0.01, z: 0.1 },
  ] }], opts);
  await conformTerrainToPlannedFeatures(terrain, plan, opts);
  for (const row of [2, 3]) {
    for (const column of [3, 4]) {
      assert.equal(terrain.elevations[row * 7 + column], 10,
        "all vertices of the triangles beneath the footprint must be below its floor");
    }
  }
});

function gradingTerrain(size, elevation) {
  return {
    elevations: new Float32Array(size * size).fill(elevation),
    minElevation: elevation, maxElevation: elevation, width: size, height: size,
    worldTile: { level: 16, x: 1, y: 1 }, generationSeed: 1,
    groundWidthMeters: 12, groundHeightMeters: 12,
    bounds: { lonWest: 0, lonEast: 1, latNorth: 1, latSouth: 0 },
  };
}

function pointInPolygon(x, z, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index];
    const b = points[previous];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function distanceToPolygonEdge(point, polygon) {
  let distance = Infinity;
  for (let index = 0; index < polygon.length; index++) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
      ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared
    ));
    distance = Math.min(distance, Math.hypot(
      point.x - start.x - dx * amount,
      point.z - start.z - dz * amount,
    ));
  }
  return distance;
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

test("a junction disc wears the widest road's finish and maps along its arms", () => {
  const marked = { ...appearance, roadClass: "tertiary", widthMeters: 6, visualStyle: "marked" };
  const service = { ...appearance, roadClass: "service", widthMeters: 3, visualStyle: "paved" };
  const plan = planRoadsAndBuildings([
    { id: "through", paths: [[{ x: -5, z: 0 }, { x: 5, z: 0 }]], appearance: marked },
    { id: "branch", paths: [[{ x: 0, z: 5 }, { x: 0, z: 0 }]], appearance: service },
  ], [], options);

  const disc = plan.roads.find((road) =>
    road.centerline[0].x === road.centerline[1].x &&
    road.centerline[0].z === road.centerline[1].z &&
    Math.hypot(road.centerline[0].x, road.centerline[0].z) < 1e-8);
  assert.ok(disc, "the T junction should raise one level disc");
  assert.equal(disc.visualStyle, "marked", "the disc must not turn into a plain paved patch");
  assert.equal(disc.sourceId, "through");
  assert.ok(disc.junctionArms && disc.junctionArms.length >= 3);
  assert.equal(disc.junctionArms[0].widthMeters, 6, "the widest road's arm comes first");
  for (const arm of disc.junctionArms) {
    assert.ok(Math.hypot(arm.axis[0].x, arm.axis[0].z) < 1e-8, "every arm starts at the node");
    assert.ok(Math.hypot(arm.axis[1].x, arm.axis[1].z) > 1, "every arm points out along an approach");
  }
  const approaches = plan.roads.filter((road) =>
    road.sourceId === "through" &&
    Math.hypot(road.centerline[1].x - road.centerline[0].x, road.centerline[1].z - road.centerline[0].z) > 1e-8);
  assert.ok(approaches.every((road) => road.junctionArms === undefined));
});

test("a dirt track keeps a dirt junction where a footpath joins it", () => {
  const track = { ...appearance, roadClass: "track", widthMeters: 2.4, surface: "unpaved", visualStyle: "dirt" };
  const path = { ...appearance, roadClass: "path", widthMeters: 1.2, visualStyle: "pedestrian" };
  const plan = planRoadsAndBuildings([
    { id: "track", paths: [[{ x: -5, z: 0 }, { x: 5, z: 0 }]], appearance: track },
    { id: "path", paths: [[{ x: 0, z: 5 }, { x: 0, z: 0 }]], appearance: path },
  ], [], options);

  const disc = plan.roads.find((road) =>
    road.centerline[0].x === road.centerline[1].x &&
    road.centerline[0].z === road.centerline[1].z &&
    Math.hypot(road.centerline[0].x, road.centerline[0].z) < 1e-8);
  assert.ok(disc);
  assert.equal(disc.visualStyle, "dirt");
});
