import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { normalizeBuildingClass, planBuilding } = await import("../src/buildings/BuildingPlanner.ts");
const planner = readFileSync(new URL("../src/buildings/BuildingPlanner.ts", import.meta.url), "utf8");
const openStreetMap = readFileSync(new URL("../src/world/OpenStreetMap.ts", import.meta.url), "utf8");
const proceduralBuildings = readFileSync(
  new URL("../src/procedural/BuildingRendererCompiler.ts", import.meta.url),
  "utf8",
);

test("plans one semantic building description before creating geometry", () => {
  assert.match(planner, /export interface BuildingPlan/);
  assert.match(planner, /export function planBuilding/);
  assert.match(planner, /detailSeed: hashString\(source\.id\)/);
  assert.match(
    openStreetMap,
    /const plan = planBuilding\(source\);[\s\S]*?ProceduralBuildingRenderer\.createDetailed\(scene, plan, terrain, renderOptions\)/,
  );
});

test("selects explicit far and detailed geometry compilers from the shared plan", () => {
  assert.match(planner, /export type BuildingDetailLevel = "far" \| "detailed"/);
  assert.match(
    openStreetMap,
    /detail === "far"\s+\? ProceduralBuildingRenderer\.createFar\(scene, plan, terrain, renderOptions\)\s+: ProceduralBuildingRenderer\.createDetailed/,
  );
});

test("keeps far massing cheap while detailed buildings add stable architectural character", () => {
  assert.match(proceduralBuildings, /export class ProceduralBuildingRenderer/);
  assert.match(proceduralBuildings, /function buildingAppearance\(/);
  assert.match(proceduralBuildings, /parseBuildingColor\(plan\.wallColor\)/);
  assert.match(proceduralBuildings, /function resolvedRoofShape\(/);
  assert.match(proceduralBuildings, /function createPitchedRoof\(/);
  assert.match(proceduralBuildings, /roofOverhangMeters\(detailSeed\) \/ options\.metersPerUnit/);
  assert.match(proceduralBuildings, /function inferredRoofHeight\(/);
  assert.match(proceduralBuildings, /const pitchDegrees = 32 \+ unitFromSeed/);
  assert.match(proceduralBuildings, /BUILDING_ROOF_EAVE_CLEARANCE_METERS/);
  assert.match(proceduralBuildings, /roofShape === "skillion"/);
  assert.match(proceduralBuildings, /function varyColor\(/);
  assert.match(proceduralBuildings, /function offsetConvexPolygon\(/);
  assert.match(proceduralBuildings, /const longestEdge = longestPolygonEdge\(eaves\)/);
  assert.match(proceduralBuildings, /roof\.convertToFlatShadedMesh\(\)/);
  assert.match(proceduralBuildings, /function createRoofTrim\(/);
  assert.match(proceduralBuildings, /function createRooftopVolume\(/);
  assert.match(proceduralBuildings, /function createEnterableBuilding\(/);
  assert.match(proceduralBuildings, /function addFacadePanel\(/);
  assert.match(proceduralBuildings, /enterable: true/);
  assert.match(proceduralBuildings, /windowCount/);
  assert.match(proceduralBuildings, /result\.useVertexColors = true/);
  assert.doesNotMatch(
    openStreetMap,
    /function createPitchedRoof|function buildingAppearance|BUILDING_ROOF_OVERHANG_METERS/,
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
      colour: " #C8B89A ",
      roof_colour: "RED",
    },
  });

  assert.equal(plan.footprint, polygon);
  assert.equal(plan.heightMeters, 12.5);
  assert.equal(plan.minimumHeightMeters, 2);
  assert.equal(plan.buildingClass, "residential");
  assert.equal(plan.roofShape, "gabled");
  assert.equal(plan.wallMaterial, "brick");
  assert.equal(plan.wallColor, "#c8b89a");
  assert.equal(plan.roofColor, "red");
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

  assert.equal(first.heightMeters, 3.1);
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
  assert.match(openStreetMap, /planRoad\(source\.properties\)/);
});

test("omits aggregate building outlines when OSM supplies 3D parts", () => {
  assert.match(openStreetMap, /truthy\(feature\.properties\.hide_3d\)/);
});

test("caches provider-tile source adaptation across application tiles", () => {
  assert.match(openStreetMap, /buildingSourceCache\.get\(tile\.data\)/);
  assert.match(openStreetMap, /buildingSourceCache\.set\(tile\.data, sources\)/);
  assert.match(openStreetMap, /roadSourceCache\.get\(tile\.data\)/);
});

test("normalizes common OSM building classes for rendering", () => {
  assert.equal(normalizeBuildingClass("house"), "residential");
  assert.equal(normalizeBuildingClass("school"), "education");
  assert.equal(normalizeBuildingClass("warehouse"), "warehouse");
  assert.equal(normalizeBuildingClass("garage"), "garage");
  assert.equal(normalizeBuildingClass("unknown_future_value"), "generic");
});
