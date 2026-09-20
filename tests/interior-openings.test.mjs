import assert from "node:assert/strict";
import test from "node:test";
import { mergeDoorOpenings, wallDoorInterval } from "../src/procedural/InteriorOpenings.ts";

const point = (x, y = 0) => ({ x, y });
const door = (a, b, id = "door") => ({ id, type: "door", start: point(a), end: point(b) });

test("overlapping inherited and generated doors become one aperture, including reversed and transitive spans", () => {
  const doors = mergeDoorOpenings([door(1, 2), door(3, 2.5), door(1.5, 2.75), door(5, 6)]);
  assert.equal(doors.length, 2);
  assert.deepEqual(doors[0].start, point(1));
  assert.deepEqual(doors[0].end, point(3));
  assert.deepEqual(mergeDoorOpenings([door(1, 2), { ...door(2, 1), fullHeight: true }])[0].fullHeight, true);
});

test("partial collinear door overlap cuts only its span instead of deleting a long wall", () => {
  assert.deepEqual(wallDoorInterval(point(0), point(10), door(-0.5, 0.8)), { minimum: 0, maximum: 0.8 });
  assert.deepEqual(wallDoorInterval(point(0), point(10), door(9.9, 11)), { minimum: 9.9, maximum: 10 });
});

test("a crossing partition keeps the rest of the wall and unrelated walls stay solid", () => {
  const opening = { ...door(0, 0), start: point(5, -1), end: point(5, 1) };
  assert.deepEqual(wallDoorInterval(point(0), point(10), opening), { minimum: 4.65, maximum: 5.35 });
  assert.equal(wallDoorInterval(point(0, 2), point(10, 2), opening), undefined);
});
