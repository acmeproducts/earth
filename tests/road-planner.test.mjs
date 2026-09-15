import assert from "node:assert/strict";
import test from "node:test";
import { planRoad, roadVegetationShoulderMeters } from "../src/roads/RoadPlanner.ts";

test("plans major roads with lane-marking visuals", () => {
  assert.deepEqual(planRoad({ class: "primary", surface: "paved" }), {
    roadClass: "primary",
    widthMeters: 8,
    shoulderWidthMeters: 1.75,
    surface: "paved",
    visualStyle: "marked",
    structure: "surface",
    layer: 0,
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
  assert.equal(planRoad({ class: "path", subclass: "footway" })?.visualStyle, "dirt");
  assert.equal(planRoad({ class: "track" })?.visualStyle, "dirt");
  assert.equal(planRoad({ class: "minor", surface: "unpaved" })?.visualStyle, "unpaved");
  assert.equal(planRoad({ class: "track", surface: "paved" })?.visualStyle, "paved");
  assert.equal(planRoad({ class: "secondary", brunnel: "tunnel" })?.isTunnel, true);
  assert.equal(planRoad({ class: "secondary", brunnel: "bridge" })?.structure, "bridge");
  assert.equal(planRoad({ class: "track", brunnel: "ford" })?.visualStyle, "ford");
});

test("lets vegetation occupy most of a small dirt road's soft shoulder", () => {
  const dirt = planRoad({ class: "track" });
  const gravel = planRoad({ class: "minor", surface: "unpaved" });
  assert.ok(dirt);
  assert.ok(gravel);
  assert.ok(Math.abs(roadVegetationShoulderMeters(dirt) - 0.11) < 1e-9);
  assert.equal(roadVegetationShoulderMeters(gravel), 0.9);
});

test("plans shoulders, ramps, construction, and vertical layers", () => {
  assert.equal(planRoad({ class: "motorway" })?.shoulderWidthMeters, 2.5);
  assert.equal(planRoad({ class: "path" })?.shoulderWidthMeters, 0.3);
  assert.equal(planRoad({ class: "primary", ramp: 1 })?.widthMeters, 5.76);
  assert.equal(planRoad({ class: "secondary_construction" })?.surface, "unpaved");
  assert.equal(planRoad({ class: "minor", layer: "2" })?.layer, 2);
});

test("ignores unsupported transport classes", () => {
  assert.equal(planRoad({ class: "rail" }), undefined);
  assert.equal(planRoad({}), undefined);
});
