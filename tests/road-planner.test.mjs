import assert from "node:assert/strict";
import test from "node:test";
import { planRoad } from "../src/RoadPlanner.ts";

test("plans major roads with lane-marking visuals", () => {
  assert.deepEqual(planRoad({ class: "primary", surface: "paved" }), {
    widthMeters: 8,
    surface: "paved",
    visualStyle: "marked",
    isTunnel: false,
  });
});

test("uses path and service subtypes for globally applicable widths", () => {
  assert.equal(planRoad({ class: "path", subclass: "footway" })?.widthMeters, 1.5);
  assert.equal(planRoad({ class: "path", subclass: "cycleway" })?.widthMeters, 2.2);
  assert.equal(planRoad({ class: "service", service: "driveway" })?.widthMeters, 2.8);
});

test("separates pedestrian, unpaved, and tunnel rendering decisions", () => {
  assert.equal(planRoad({ class: "path", subclass: "cycleway" })?.visualStyle, "pedestrian");
  assert.equal(planRoad({ class: "path", subclass: "footway" })?.visualStyle, "unpaved");
  assert.equal(planRoad({ class: "track", surface: "paved" })?.visualStyle, "paved");
  assert.equal(planRoad({ class: "secondary", brunnel: "tunnel" })?.isTunnel, true);
});

test("ignores unsupported transport classes", () => {
  assert.equal(planRoad({ class: "rail" }), undefined);
  assert.equal(planRoad({}), undefined);
});
