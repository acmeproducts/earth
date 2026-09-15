import assert from "node:assert/strict";
import test from "node:test";
import polygonClipping from "polygon-clipping";
import { planBuildingLayout } from "../src/buildings/BuildingLayoutPlanner.ts";
import { overlappingSegment } from "../src/core/PolygonGeometry.ts";

const rect = (x, y, w, h) => ({ outer: [{x,y}, {x:x+w,y}, {x:x+w,y:y+h}, {x,y:y+h}] });
const rings = (polygon) => [polygon.outer, ...(polygon.holes ?? [])].map((ring) => ring.map((p) => [p.x,p.y]));
const area = (polygons) => polygons.reduce((sum, polygon) => sum + polygon.reduce((total, ring, index) => {
  const value = Math.abs(ring.reduce((a, p, i) => {
    const q = ring[(i+1)%ring.length];
    return a+p[0]*q[1]-p[1]*q[0];
  }, 0))/2;
  return total+(index ? -value : value);
}, 0), 0);

for (const angle of [0, 0.37]) test(`floor planning respects voids and stair landings at rotation ${angle}`, () => {
  const transform = ({x,y}) => ({x:100+x*Math.cos(angle)-y*Math.sin(angle), y:-70+x*Math.sin(angle)+y*Math.cos(angle)});
  const polygon = (p) => ({ outer:p.outer.map(transform), holes:p.holes?.map((h) => h.map(transform)) });
  const boundary = polygon({ ...rect(0,0,40,30), holes:[rect(12,8,10,12).outer, rect(28,20,4,5).outer] });
  const circulation = [rect(1,1,7,3), rect(1,2,7,3), rect(32,2,7,3)].map(polygon);
  const input = {buildingPolygon:boundary, circulation, buildingType:"apartment-building"};
  const layout = planBuildingLayout(input);
  assert.deepEqual(planBuildingLayout(input), layout);
  assert.equal(layout.boundary.holes.length, 2);
  const roomPolygons = layout.rooms.map((room) => rings(room.polygon));
  const occupied = polygonClipping.union(roomPolygons[0], ...roomPolygons.slice(1));
  assert.ok(area(polygonClipping.xor(occupied, rings(boundary))) < 1e-6, "rooms cover exactly the usable floor");
  assert.ok(Math.abs(roomPolygons.reduce((sum,p) => sum+area([p]),0)-area(occupied)) < 1e-6, "room interiors do not overlap");
  const apartments = layout.rooms.filter((room) => room.type === "apartment");
  assert.ok(apartments.length > 1);
  for (const room of apartments) for (const reserved of circulation) {
    assert.ok(area(polygonClipping.intersection(rings(room.polygon), rings(reserved))) < 1e-6,
      "apartments leave stair flights and landings clear");
  }
  assert.ok(layout.openings.some((opening) => opening.fullHeight));
  const touches = (room, door) => room.polygon.outer.some((start, index, points) => {
    const shared = overlappingSegment(start, points[(index+1)%points.length], door.start, door.end);
    return shared && Math.hypot(shared[1].x-shared[0].x, shared[1].y-shared[0].y) >= 0.75;
  });
  const reached = new Set([layout.rooms[0]]);
  let size;
  do {
    size = reached.size;
    for (const door of layout.openings.filter((opening) => opening.type === "door")) {
      const adjacent = layout.rooms.filter((room) => touches(room, door));
      if (adjacent.some((room) => reached.has(room))) adjacent.forEach((room) => reached.add(room));
    }
  } while (reached.size > size);
  assert.equal(reached.size, layout.rooms.length, "all floor regions connect through walkable openings");
});
