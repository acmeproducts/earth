import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { planBuilding } from "../src/BuildingPlanner.ts";

const planner = readFileSync(new URL("../src/BuildingPlanner.ts", import.meta.url), "utf8");
const openStreetMap = readFileSync(new URL("../src/OpenStreetMap.ts", import.meta.url), "utf8");

test("plans one semantic building description before creating geometry", () => {
  assert.match(planner, /export interface BuildingPlan/);
  assert.match(planner, /export function planBuilding/);
  assert.match(planner, /detailSeed: hashString\(source\.id\)/);
  assert.match(openStreetMap, /createDetailedBuilding\(scene, planBuilding\(source\), terrain, options\)/);
});

test("selects explicit far and detailed geometry compilers from the shared plan", () => {
  assert.match(planner, /export type BuildingDetailLevel = "far" \| "detailed"/);
  assert.match(
    openStreetMap,
    /detail === "far"\s+\? createFarBuilding\(scene, plan, terrain, options\)\s+: createDetailedBuilding/,
  );
});

test("normalizes mapped attributes while preserving the source footprint", () => {
  const polygon = {
    outer: [[10, 60], [11, 60], [11, 61], [10, 60]],
    holes: [[[10.2, 60.2], [10.3, 60.2], [10.2, 60.2]]],
  };
  const plan = planBuilding({
    id: "building/14/42/0",
    polygon,
    properties: {
      class: " Residential ",
      render_height: "12.5",
      render_min_height: 2,
      roof_shape: "GABLED",
      material: "Brick",
    },
  });

  assert.equal(plan.footprint, polygon);
  assert.equal(plan.heightMeters, 12.5);
  assert.equal(plan.minimumHeightMeters, 2);
  assert.equal(plan.buildingClass, "residential");
  assert.equal(plan.roofShape, "gabled");
  assert.equal(plan.wallMaterial, "brick");
});

test("uses stable defaults and identity-derived detail seeds", () => {
  const source = {
    id: "building/14/42/0",
    polygon: { outer: [], holes: [] },
    properties: {},
  };
  const first = planBuilding(source);
  const second = planBuilding({ ...source, properties: { render_height: "invalid" } });
  const neighbor = planBuilding({ ...source, id: "building/14/43/0" });

  assert.equal(first.heightMeters, 8);
  assert.equal(first.minimumHeightMeters, 0);
  assert.equal(first.detailSeed, second.detailSeed);
  assert.notEqual(first.detailSeed, neighbor.detailSeed);
});

test("retains interior rings while adapting vector-tile buildings", () => {
  assert.match(planner, /holes: LonLat\[\]\[\]/);
  assert.match(openStreetMap, /polygon: \{ outer: rings\[0\], holes: rings\.slice\(1\) \}/);
});

test("extracts roads into context-ready records shared by map consumers", () => {
  assert.match(openStreetMap, /interface RoadSource/);
  assert.match(openStreetMap, /for \(const source of roadSources\(tile\)\)/);
  assert.match(openStreetMap, /roadAppearance\(source\.properties\)/);
});

test("caches provider-tile source adaptation across application tiles", () => {
  assert.match(openStreetMap, /buildingSourceCache\.get\(tile\.data\)/);
  assert.match(openStreetMap, /buildingSourceCache\.set\(tile\.data, sources\)/);
  assert.match(openStreetMap, /roadSourceCache\.get\(tile\.data\)/);
});
