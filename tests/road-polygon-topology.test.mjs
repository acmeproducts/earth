import test from "node:test";
import assert from "node:assert/strict";
import earcut, { deviation } from "earcut";
import { planRoadsAndBuildings } from "../src/roads/RoadAndBuildingPlanner.ts";
import { planRoad } from "../src/roads/RoadPlanner.ts";

function assertSimple(road) {
  const ring = road.outline;
  const cross = (a, b, c) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const onSegment = (a, b, p) => Math.abs(cross(a, b, p)) < 1e-12 &&
    p.x >= Math.min(a.x, b.x) - 1e-12 && p.x <= Math.max(a.x, b.x) + 1e-12 &&
    p.z >= Math.min(a.z, b.z) - 1e-12 && p.z <= Math.max(a.z, b.z) + 1e-12;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    for (let j = i + 2; j < ring.length; j++) {
      if (i === 0 && j === ring.length - 1) continue;
      const c = ring[j], d = ring[(j + 1) % ring.length];
      const crossing = cross(a, b, c) * cross(a, b, d) < -1e-16 &&
        cross(c, d, a) * cross(c, d, b) < -1e-16;
      assert.ok(!crossing && !onSegment(a, b, c) && !onSegment(a, b, d) &&
        !onSegment(c, d, a) && !onSegment(c, d, b),
      `${road.sourceId}: boundary intersects itself at edges ${i}/${j}: ${JSON.stringify(ring)}`);
    }
  }
  const flat = ring.flatMap(p => [p.x, p.z]);
  const area = Math.abs(ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return sum + p.x * q.z - p.z * q.x;
  }, 0) / 2);
  assert.ok(area < 1e-7 || deviation(flat, [], 2, earcut(flat)) < 1e-5,
    `triangulation must preserve polygon area: ${JSON.stringify(ring)}`);
}

test("crowded bends and crossings emit simple road and shoulder boundaries", () => {
  let seed = 42;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let sample = 0; sample < 30; sample++) {
    const roads = Array.from({ length: 4 }, (_, index) => ({
      id: `sample-${sample}-road-${index}`,
      appearance: planRoad({ class: "secondary" }),
      paths: [Array.from({ length: 5 }, () => ({ x: random() * 40 - 20, z: random() * 40 - 20 }))],
    }));
    const plan = planRoadsAndBuildings(roads, [], { meshWidth: 60, meshDepth: 60, metersPerUnit: 1 });
    for (const road of [...plan.roads, ...plan.shoulders]) assertSimple(road);
  }
});

test("hairpins, closed loops and repeated points stay simple at tile scales", () => {
  const paths = [
    [[-20, 0], [10, 0], [9, 1], [-15, 2]],
    [[-12, -12], [12, -12], [12, 12], [-12, 12], [-12, -12]],
    [[-20, -5], [0, 0], [0, 0], [0.001, 0.001], [20, 5]],
  ];
  for (const metersPerUnit of [1, 10, 100]) {
    for (const path of paths) {
      const plan = planRoadsAndBuildings([{
        id: "bend",
        appearance: planRoad({ class: "secondary" }),
        paths: [path.map(([x, z]) => ({ x: x / metersPerUnit, z: z / metersPerUnit }))],
      }], [], { meshWidth: 60 / metersPerUnit, meshDepth: 60 / metersPerUnit, metersPerUnit });
      assert.ok(plan.roads.length > 0);
      for (const road of [...plan.roads, ...plan.shoulders]) assertSimple(road);
    }
  }
});
