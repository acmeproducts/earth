import assert from "node:assert/strict";
import test from "node:test";
import { createWaterRoadOverlapFilter } from "../src/WaterRoadOverlap.ts";
import { planRoad } from "../src/RoadPlanner.ts";

const box = (x, z, width, depth) => ({ outline: [
  { x, z }, { x: x + width, z }, { x: x + width, z: z + depth }, { x, z: z + depth },
], holes: [] });
const water = box(0, 0, 10, 10);
const road = (z, properties = {}, paths = [[{ x: -20, z }, { x: 30, z }]]) => ({
  paths, appearance: planRoad({ class: "minor", ...properties }),
});
const rejects = (roads, body = water, scale = 1) =>
  createWaterRoadOverlapFilter(roads, scale, 20 / scale)(body);

test("rejects puddles on roads and water crossed by ordinary city streets", () => {
  assert.equal(rejects([road(5)]), true);
  assert.equal(rejects([road(5)], box(2, 4, 2, 2)), true);
  assert.equal(rejects([road(5, { class: "path", subclass: "footway" })]), true);
});

test("preserves mapped bridges, tunnels, fords and roads on other layers", () => {
  for (const properties of [
    { brunnel: "bridge" }, { brunnel: "tunnel" }, { brunnel: "ford" }, { layer: 1 }, { layer: -1 },
  ]) assert.equal(rejects([road(5, properties)]), false);
});

test("keeps nearby ponds, touching shorelines, and slight map misalignment", () => {
  for (const z of [-5, -2, -1.5]) assert.equal(rejects([road(z)]), false);
  assert.equal(rejects([road(0)], box(-100, -100, 200, 200)), false);
});

test("respects islands and never counts duplicate roads twice", () => {
  const lake = box(0, 0, 10, 10);
  lake.holes = [box(0, 2, 10, 6).outline];
  assert.equal(rejects([road(5)], lake), false);
  assert.equal(rejects([road(-1.5), road(-1.5), road(-1.5)]), false);
  assert.equal(rejects([road(-1.5), road(11.5)]), true);
});

test("uses physical widths across scene scales and handles degenerate segments", () => {
  const paths = [[{ x: -2, z: 0.5 }, { x: -2, z: 0.5 }, { x: 3, z: 0.5 }]];
  assert.equal(rejects([road(0, {}, paths)], box(0, 0, 1, 1), 10), true);
  assert.equal(rejects([road(0, {}, [[{ x: 5, z: 5 }, { x: 5, z: 5 }]])]), false);
});
