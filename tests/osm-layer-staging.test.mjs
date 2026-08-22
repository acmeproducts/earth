import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const openStreetMap = readFileSync(new URL("../src/OpenStreetMap.ts", import.meta.url), "utf8");
const roadPlanner = readFileSync(new URL("../src/RoadPlanner.ts", import.meta.url), "utf8");
const lakeSurface = readFileSync(new URL("../src/LakeSurface.ts", import.meta.url), "utf8");
const proceduralBuildings = readFileSync(
  new URL("../src/ProceduralBuildingRenderer.ts", import.meta.url),
  "utf8",
);

test("stages every OSM mesh out of render lists until the layer is assembled", () => {
  assert.match(openStreetMap, /function stageMapMesh<T extends Mesh>[\s\S]*?mesh\.setEnabled\(false\)/);
  assert.match(proceduralBuildings, /stageBuildingMesh\(\s*new PolygonMeshBuilder\("building"/);
  assert.match(openStreetMap, /stageMapMesh\(\s*new PolygonMeshBuilder\("water"/);
  assert.match(openStreetMap, /stageMapMesh\(\s*MeshBuilder\.CreateRibbon\("road"/);
});

test("enables completed meshes only after parenting them to the layer root", () => {
  const mergeStart = openStreetMap.indexOf("const meshes = [");
  const enable = openStreetMap.indexOf("for (const mesh of meshes) mesh.setEnabled(true);", mergeStart);
  const result = openStreetMap.indexOf("return {", enable);

  assert.ok(mergeStart >= 0 && enable > mergeStart && result > enable);
  assert.match(openStreetMap, /if \(options\.startDisabled\) root\.setEnabled\(false\)/);
});

test("renders every feature portion intersecting an application tile", () => {
  assert.doesNotMatch(openStreetMap, /ownerBounds|ownsGeometry/);
  assert.match(
    openStreetMap,
    /clipPolyline\(\s*points,\s*options\.meshWidth \/ 2,\s*options\.meshDepth \/ 2/,
  );
});

test("drapes roads at a meter-scale clearance", () => {
  assert.match(openStreetMap, /const ROAD_SURFACE_CLEARANCE_METERS = 0\.025/);
  assert.match(
    openStreetMap,
    /\(leftElevation \+ ROAD_SURFACE_CLEARANCE_METERS\) \/ options\.metersPerUnit/,
  );
  assert.doesNotMatch(openStreetMap, /leftElevation \/ options\.metersPerUnit \+ 0\.025/);
});

test("styles OSM road classes, path types, and surfaces separately", () => {
  assert.match(roadPlanner, /properties\.surface/);
  assert.match(roadPlanner, /track: 2\.4/);
  assert.match(roadPlanner, /cycleway: 2\.2/);
  assert.match(roadPlanner, /driveway: 2\.8/);
  assert.match(openStreetMap, /mergeRoads\(roadMeshes\.marked, "markedRoads", "marked"/);
  assert.match(openStreetMap, /mergeRoads\(roadMeshes\.pedestrian, "pedestrianRoads", "pedestrian"/);
  assert.match(openStreetMap, /mergeRoads\(roadMeshes\.unpaved, "unpavedRoads", "unpaved"/);
  assert.match(openStreetMap, /material\.bumpTexture = relief/);
});

test("renders permanent mapped waterways as terrain-following water ribbons", () => {
  assert.match(openStreetMap, /forEachFeature\(tile, "waterway"/);
  assert.match(openStreetMap, /truthy\(feature\.properties\.intermittent\)/);
  assert.match(openStreetMap, /createWaterway\(scene, line, terrain, options, widthMeters\)/);
  assert.match(openStreetMap, /mergeWaterways\(waterways, root, options\)/);
});

test("extends lake surfaces beneath the terrain shoreline transition", () => {
  assert.match(lakeSurface, /const LAKE_MAX_UNDERLAP_METERS = 80/);
  assert.match(lakeSurface, /const LAKE_TERRAIN_TRANSITION_MARGIN_METERS = 35/);
  assert.match(lakeSurface, /const LAKE_FALLBACK_UNDERLAP_METERS = 8/);
  assert.match(
    lakeSurface,
    /lakeUnderlapDistance\(point, normal, terrain, options\)/,
  );
  assert.match(openStreetMap, /const expanded = expandLakeShoreline\(points, terrain, options\)/);
  assert.match(lakeSurface, /const incoming = outwardNormal/);
  assert.match(lakeSurface, /const outgoing = outwardNormal/);
  assert.match(openStreetMap, /const mappedFootprint = clipPolygon\(points, clipBounds\)/);
});

test("checks the carved terrain water mask before extending a lake edge", () => {
  assert.match(lakeSurface, /if \(!terrain\.waterMask\) return fallback/);
  assert.match(lakeSurface, /function sampleWaterMask/);
  assert.match(lakeSurface, /if \(u < 0 \|\| u > 1 \|\| v < 0 \|\| v > 1\) return false/);
  assert.match(lakeSurface, /furthestWater \+ margin/);
});

test("merges inland water and gives it the reflective ocean material", () => {
  const styleStart = lakeSurface.indexOf("export function styleLakeSurfaces(");
  const styleWater = lakeSurface.slice(styleStart);
  assert.match(styleWater, /Mesh\.MergeMeshes\(pieces, true, true\)/);
  assert.match(styleWater, /createWaterSurfaceMaterial\(parent\.getScene\(\)/);
  assert.match(styleWater, /skyReflection: options\.skyReflection/);
  assert.doesNotMatch(styleWater, /material\.alpha|new StandardMaterial/);
});

test("levels and textures every provider fragment as one continuous lake", () => {
  assert.match(openStreetMap, /function waterFeatureSourceId/);
  assert.match(openStreetMap, /`water\/\$\{tile\.zoom\}\/\$\{String\(feature\.id\)\}`/);
  assert.match(lakeSurface, /const lakeLevels = new Map<string, LakeLevelState>/);
  assert.match(lakeSurface, /state\.observations\.set\(observationKey/);
  assert.match(lakeSurface, /surface\.mesh\.position\.y =/);
  assert.match(lakeSurface, /positions\[vertex \* 3\] \+ worldOffsetX/);
});

test("keeps lake implementation out of the OSM source adapter", () => {
  assert.match(openStreetMap, /from "\.\/LakeSurface"/);
  assert.match(openStreetMap, /prepareLakeSurfacePiece\(/);
  assert.match(openStreetMap, /styleLakeSurfaces\(water, root, options\)/);
  assert.doesNotMatch(openStreetMap, /function lakeUnderlapDistance|const lakeLevels|function setWaterUvs/);
});

test("preserves the shared sky reflection when a streamed lake layer is disposed", () => {
  assert.match(openStreetMap, /static disposeLayer\(root: TransformNode\)/);
  assert.match(
    openStreetMap,
    /mesh\.material instanceof PBRMaterial \|\| mesh\.material instanceof StandardMaterial/,
  );
  assert.match(openStreetMap, /root\.dispose\(false, true\)/);
});
