import test from "node:test";
import assert from "node:assert/strict";

const { planRoadsAndBuildings, roadGradeAmount } =
  await import("../src/roads/RoadAndBuildingPlanner.ts");

const secondary = {
  roadClass: "secondary",
  widthMeters: 7,
  shoulderWidthMeters: 1.5,
  surface: "paved",
  visualStyle: "marked",
  structure: "surface",
  layer: 0,
  isTunnel: false,
};
const options = { meshWidth: 140, meshDepth: 140, metersPerUnit: 1 };

function ringPath(radius, steps) {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = (index / steps) * Math.PI * 2;
    return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
  });
}

function roundabout(radius = 14, steps = 24) {
  return planRoadsAndBuildings([
    { id: "roundabout", paths: [ringPath(radius, steps)], appearance: secondary },
    { id: "arm-e", paths: [[{ x: radius, z: 0 }, { x: 60, z: 0 }]], appearance: secondary },
    { id: "arm-w", paths: [[{ x: -radius, z: 0 }, { x: -60, z: 0 }]], appearance: secondary },
    { id: "arm-n", paths: [[{ x: 0, z: radius }, { x: 0, z: 60 }]], appearance: secondary },
  ], [], options);
}

function area(ring) {
  return Math.abs(ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return sum + point.x * next.z - next.x * point.z;
  }, 0) / 2);
}

function inside(point, ring) {
  let hit = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index];
    const b = ring[previous];
    if ((a.z > point.z) !== (b.z > point.z) &&
        point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

function length(road) {
  return Math.hypot(
    road.centerline[1].x - road.centerline[0].x,
    road.centerline[1].z - road.centerline[0].z,
  );
}

test("builds a roundabout from carriageway pieces, not a chain of junction discs", () => {
  const plan = roundabout();
  // Every shape vertex used to raise its own full-width disc, and because the
  // ring is sampled more finely than it is wide the discs consumed the pieces
  // between them, leaving only the crescents where they overlapped.
  assert.ok(
    plan.roads.length <= 60,
    `a three-armed roundabout should not shatter, got ${plan.roads.length} polygons`,
  );
  const slivers = plan.roads.filter((road) => area(road.outline) < 1).length;
  assert.ok(slivers <= plan.roads.length / 4, `too many slivers: ${slivers}`);
  const directionless = plan.roads.filter((road) =>
    length(road) < 1e-6 && !road.textureAxis);
  assert.deepEqual(directionless, [], "every polygon must carry a texture direction");
});

test("covers the whole carriageway of a roundabout exactly once", () => {
  const plan = roundabout();
  let covered = 0;
  let uncovered = 0;
  let doubled = 0;
  for (let x = -20; x <= 20; x += 0.25) {
    for (let z = -20; z <= 20; z += 0.25) {
      const point = { x, z };
      const owners = plan.roads.filter((road) => inside(point, road.outline));
      if (owners.length > 1) doubled++;
      // The ring's own band, kept clear of the three arms.
      const radial = Math.hypot(x, z);
      if (Math.abs(radial - 14) < secondary.widthMeters / 2 - 0.6 &&
          Math.abs(x) > 6 && Math.abs(z) > 6) {
        covered++;
        if (owners.length === 0) uncovered++;
      }
    }
  }
  assert.ok(covered > 1000, "the sampling must actually reach the carriageway");
  assert.equal(uncovered, 0, "the ring must have no holes");
  assert.equal(doubled, 0, "carriageway polygons must stay mutually exclusive");
});

test("keeps a roundabout's grade continuous across a steep hillside", () => {
  const plan = roundabout();
  const elevation = (point) => 100 + point.x * 0.08 - point.z * 0.05;
  const gradeAt = (road, point) => {
    const start = elevation(road.centerline[0]);
    const end = elevation(road.centerline[1]);
    return start + (end - start) * roadGradeAmount(road, point);
  };
  const step = 0.25;
  const heights = new Map();
  const key = (x, z) => `${x.toFixed(2)}/${z.toFixed(2)}`;
  for (let x = -20; x <= 20; x += step) {
    for (let z = -20; z <= 20; z += step) {
      const point = { x, z };
      const owner = plan.roads.find((road) => inside(point, road.outline));
      if (owner) heights.set(key(x, z), gradeAt(owner, point));
    }
  }
  let worst = 0;
  for (let x = -20; x <= 20; x += step) {
    for (let z = -20; z <= 20; z += step) {
      const here = heights.get(key(x, z));
      if (here === undefined) continue;
      for (const [dx, dz] of [[step, 0], [0, step]]) {
        const next = heights.get(key(x + dx, z + dz));
        if (next !== undefined) worst = Math.max(worst, Math.abs(next - here));
      }
    }
  }
  // The ring climbs 2.2 m across this slope, and every junction disc is level
  // by design, so some lip is unavoidable. It must stay well under a step.
  assert.ok(worst < 0.25, `grade breaks by ${worst.toFixed(3)} m between neighbours`);
});

test("keeps a side road's junction when the road it meets is simplified", () => {
  const curve = Array.from({ length: 41 }, (_, index) => ({
    x: -40 + index * 2,
    z: Math.sin(index / 40 * Math.PI) * 6,
  }));
  const meeting = curve[20];
  const plan = planRoadsAndBuildings([
    { id: "curve", paths: [curve], appearance: secondary },
    { id: "side", paths: [[meeting, { x: meeting.x, z: meeting.z + 40 }]], appearance: secondary },
  ], [], options);

  const disc = plan.roads.find((road) =>
    length(road) < 1e-6 &&
    Math.hypot(road.centerline[0].x - meeting.x, road.centerline[0].z - meeting.z) < 1e-6);
  assert.ok(disc, "the meeting point must still raise one level junction");
  assert.ok(
    plan.roads.some((road) => inside({ x: meeting.x, z: meeting.z + 20 }, road.outline)),
    "the side road must still be built",
  );
});
