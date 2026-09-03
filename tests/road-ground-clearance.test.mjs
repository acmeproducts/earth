import test from "node:test";
import assert from "node:assert/strict";

const { planRoadsAndBuildings } = await import("../src/RoadAndBuildingPlanner.ts");
const { conformTerrainToPlannedFeatures } = await import("../src/PlannedFeatureTerrain.ts");
const { TerrainSurface, conformDecalPolygon } = await import("../src/TerrainSurface.ts");

const options = { meshWidth: 25, meshDepth: 25, metersPerUnit: 24 };
const appearance = {
  roadClass: "minor",
  widthMeters: 4,
  shoulderWidthMeters: 1.5,
  surface: "paved",
  visualStyle: "paved",
  structure: "surface",
  layer: 0,
  isTunnel: false,
};

/** A steep, saddled hillside: the shape road grading has always struggled with. */
function ruggedTerrain(size) {
  const elevations = new Float32Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const u = column / (size - 1);
      const v = row / (size - 1);
      elevations[row * size + column] = 120 +
        60 * u -
        45 * v +
        30 * Math.sin(u * 7.3) * Math.cos(v * 5.1) +
        12 * Math.sin((u + v) * 13.7);
    }
  }
  let minElevation = Infinity;
  let maxElevation = -Infinity;
  for (const elevation of elevations) {
    minElevation = Math.min(minElevation, elevation);
    maxElevation = Math.max(maxElevation, elevation);
  }
  return {
    elevations,
    minElevation,
    maxElevation,
    width: size,
    height: size,
    worldTile: { level: 15, x: 1, y: 1 },
    generationSeed: 7,
    groundWidthMeters: options.meshWidth * options.metersPerUnit,
    groundHeightMeters: options.meshDepth * options.metersPerUnit,
    bounds: { lonWest: 0, lonEast: 0.01, latNorth: 0.01, latSouth: 0 },
  };
}

/** Mirrors createTerrainMesh: ground vertices carry bilinear elevation samples. */
function renderedSurface(terrain, subdivisions) {
  const heights = new Float32Array((subdivisions + 1) * (subdivisions + 1));
  for (let row = 0; row <= subdivisions; row++) {
    for (let column = 0; column <= subdivisions; column++) {
      const pixelX = (column / subdivisions) * (terrain.width - 1);
      const pixelY = (row / subdivisions) * (terrain.height - 1);
      const x0 = Math.floor(pixelX);
      const y0 = Math.floor(pixelY);
      const x1 = Math.min(x0 + 1, terrain.width - 1);
      const y1 = Math.min(y0 + 1, terrain.height - 1);
      const fx = pixelX - x0;
      const fy = pixelY - y0;
      heights[row * (subdivisions + 1) + column] = (
        terrain.elevations[y0 * terrain.width + x0] * (1 - fx) * (1 - fy) +
        terrain.elevations[y0 * terrain.width + x1] * fx * (1 - fy) +
        terrain.elevations[y1 * terrain.width + x0] * (1 - fx) * fy +
        terrain.elevations[y1 * terrain.width + x1] * fx * fy
      ) / options.metersPerUnit;
    }
  }
  return new TerrainSurface(heights, subdivisions, options.meshWidth, options.meshDepth);
}

function bilinearElevation(terrain, x, z) {
  const u = Math.min(1, Math.max(0, x / options.meshWidth + 0.5));
  const v = Math.min(1, Math.max(0, 0.5 - z / options.meshDepth));
  const pixelX = u * (terrain.width - 1);
  const pixelY = v * (terrain.height - 1);
  const x0 = Math.floor(pixelX);
  const y0 = Math.floor(pixelY);
  const x1 = Math.min(x0 + 1, terrain.width - 1);
  const y1 = Math.min(y0 + 1, terrain.height - 1);
  const fx = pixelX - x0;
  const fy = pixelY - y0;
  return terrain.elevations[y0 * terrain.width + x0] * (1 - fx) * (1 - fy) +
    terrain.elevations[y0 * terrain.width + x1] * fx * (1 - fy) +
    terrain.elevations[y1 * terrain.width + x0] * (1 - fx) * fy +
    terrain.elevations[y1 * terrain.width + x1] * fx * fy;
}

/** The planned grade createPlannedRoadBatch lays over one carriageway polygon. */
function plannedGrade(road, terrain) {
  const start = bilinearElevation(terrain, road.centerline[0].x, road.centerline[0].z);
  const end = bilinearElevation(terrain, road.centerline[1].x, road.centerline[1].z);
  const dx = road.centerline[1].x - road.centerline[0].x;
  const dz = road.centerline[1].z - road.centerline[0].z;
  const lengthSquared = dx * dx + dz * dz;
  return (point) => {
    const amount = lengthSquared <= 1e-12
      ? 0
      : Math.max(0, Math.min(1, (
        (point.x - road.centerline[0].x) * dx +
        (point.z - road.centerline[0].z) * dz
      ) / lengthSquared));
    return (start + (end - start) * amount) / options.metersPerUnit;
  };
}

function roadNetwork() {
  const inputs = [];
  for (let index = 0; index < 5; index++) {
    const offset = -8 + index * 4;
    inputs.push({
      id: `east-west-${index}`,
      paths: [[{ x: -12, z: offset }, { x: 2, z: offset + 1.5 }, { x: 12, z: offset }]],
      appearance,
    });
    inputs.push({
      id: `north-south-${index}`,
      paths: [[{ x: offset, z: -12 }, { x: offset - 1.5, z: 3 }, { x: offset, z: 12 }]],
      appearance,
    });
  }
  return inputs;
}

/** Lowest point of a fragment relative to the ground triangle beneath it. */
function lowestClearance(rings, surface) {
  let lowest = Infinity;
  for (const ring of rings) {
    for (const vertex of ring) {
      lowest = Math.min(lowest, vertex.y - surface.heightAt(vertex));
    }
    // Interior points cannot dip below the vertices of a fragment that lies in
    // one ground triangle, but sample them anyway so a broken split is caught.
    for (let index = 2; index < ring.length; index++) {
      const triangle = [ring[0], ring[index - 1], ring[index]];
      for (const [a, b, c] of [[0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6], [1 / 3, 1 / 3, 1 / 3]]) {
        const point = {
          x: triangle[0].x * a + triangle[1].x * b + triangle[2].x * c,
          z: triangle[0].z * a + triangle[1].z * b + triangle[2].z * c,
        };
        const y = triangle[0].y * a + triangle[1].y * b + triangle[2].y * c;
        lowest = Math.min(lowest, y - surface.heightAt(point));
      }
    }
  }
  return lowest;
}

test("keeps every planned road surface above the ground it is drawn on", async () => {
  const terrain = ruggedTerrain(33);
  const plan = planRoadsAndBuildings(roadNetwork(), [], options);
  await conformTerrainToPlannedFeatures(terrain, plan, options);
  const surface = renderedSurface(terrain, terrain.width - 1);
  const clearance = 0.025 / options.metersPerUnit;

  let checked = 0;
  let fragments = 0;
  let lowest = Infinity;
  for (const road of [...plan.roads, ...plan.shoulders]) {
    if (road.structure === "bridge") continue;
    const rings = conformDecalPolygon(
      road.outline,
      plannedGrade(road, terrain),
      clearance,
      surface,
    );
    assert.ok(rings.length > 0, "every carriageway must produce geometry");
    lowest = Math.min(lowest, lowestClearance(rings, surface));
    fragments += rings.length;
    checked++;
  }

  assert.ok(checked > 20, `expected a dense network, planned ${checked} polygons`);
  assert.ok(
    fragments / checked < 12,
    `splitting must stay proportionate, got ${fragments / checked} fragments per polygon`,
  );
  assert.ok(
    lowest >= clearance - 1e-9,
    `roads must stay a full clearance above the ground, got ${lowest * options.metersPerUnit}m`,
  );
});

test("a road laid on its planned grade alone does cut through rugged ground", async () => {
  const terrain = ruggedTerrain(33);
  const plan = planRoadsAndBuildings(roadNetwork(), [], options);
  await conformTerrainToPlannedFeatures(terrain, plan, options);
  const surface = renderedSurface(terrain, terrain.width - 1);

  let lowest = Infinity;
  for (const road of [...plan.roads, ...plan.shoulders]) {
    const rings = conformDecalPolygon(road.outline, plannedGrade(road, terrain), 0);
    lowest = Math.min(lowest, lowestClearance(rings, surface));
  }
  assert.ok(
    lowest < -0.05 / options.metersPerUnit,
    "the unconformed grade should sink into the ground, or this network proves nothing",
  );
});

test("splits a polygon into fragments that tile it exactly", () => {
  const terrain = ruggedTerrain(9);
  const surface = renderedSurface(terrain, 8);
  const outline = [
    { x: -3.4, z: -2.1 },
    { x: 4.2, z: -1.3 },
    { x: 3.1, z: 2.6 },
    { x: -2.7, z: 1.9 },
  ];
  const pieces = surface.splitByGroundTriangles(outline);
  const area = (ring) => Math.abs(ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return sum + point.x * next.z - next.x * point.z;
  }, 0) / 2);
  const total = pieces.reduce((sum, piece) => sum + area(piece.outline), 0);
  assert.ok(pieces.length > 4, `expected several fragments, got ${pieces.length}`);
  assert.ok(Math.abs(total - area(outline)) < 1e-9, "fragments must tile the polygon");
  for (const piece of pieces) {
    for (const point of piece.outline) {
      assert.ok(
        Math.abs(piece.height(point) - surface.heightAt(point)) < 1e-6,
        "a fragment's plane must be the ground plane it lies on",
      );
    }
  }
});
