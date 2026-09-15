import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const openStreetMap = readFileSync(new URL("../src/world/OpenStreetMap.ts", import.meta.url), "utf8");
const roadPlanner = readFileSync(new URL("../src/roads/RoadPlanner.ts", import.meta.url), "utf8");
const proceduralBuildings = readFileSync(
  new URL("../src/procedural/BuildingRendererCompiler.ts", import.meta.url),
  "utf8",
);

test("stages every OSM mesh out of render lists until the layer is assembled", () => {
  assert.match(openStreetMap, /function stageMapMesh<T extends Mesh>[\s\S]*?mesh\.setEnabled\(false\)/);
  assert.match(proceduralBuildings, /return stageBuildingMesh\(merged\)/);
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
    /\(centerElevation \+ clearanceMeters\) \/ options\.metersPerUnit/,
  );
  assert.doesNotMatch(openStreetMap, /leftElevation \/ options\.metersPerUnit \+ 0\.025/);
});

test("renders surface roads with decal-style depth bias over terrain", () => {
  assert.match(openStreetMap, /const ROAD_SURFACE_DEPTH_BIAS = -2/);
  assert.match(openStreetMap, /const ROAD_SHOULDER_DEPTH_BIAS = -1/);
  assert.match(openStreetMap, /material\.zOffset = depthBias/);
  assert.match(openStreetMap, /material\.zOffsetUnits = depthBias/);
  assert.match(openStreetMap, /visualStyle !== "bridgeDeck"/);
});

test("uses one road and building plan before terrain construction", () => {
  const game = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
  assert.match(game, /OpenStreetMap\.prepareRoadAndBuildingInputs\(/);
  assert.match(game, /await this\.roadPlanningWorker\.plan\(/);
  assert.match(game, /OpenStreetMap\.conformTerrainToPlan\(/);
  assert.doesNotMatch(game, /OpenStreetMap\.conformTerrainTo(?:Buildings|Roads)\(/);
});

test("renders planned junctions once instead of layering endpoint ribbons", () => {
  assert.match(openStreetMap, /createPlannedRoadMeshes\(scene, options\.planning\.roads/);
  assert.match(openStreetMap, /new Mesh\("plannedRoadSurface", scene\)/);
  assert.match(
    openStreetMap,
    /if \(options\.planning && appearance\.structure !== "bridge"\) continue;/,
  );
  assert.match(
    openStreetMap,
    /vertexOffset \+ localIndices\[index \+ 1\],[\s\S]*vertexOffset \+ localIndices\[index \+ 2\]/,
  );
  assert.match(openStreetMap, /VertexData\.ComputeNormals\(positions, indices, normals\)/);
});

test("styles OSM road classes, path types, and surfaces separately", () => {
  assert.match(roadPlanner, /properties\.surface/);
  assert.match(roadPlanner, /track: 2\.4/);
  assert.match(roadPlanner, /cycleway: 2\.2/);
  assert.match(roadPlanner, /driveway: 2\.8/);
  assert.match(openStreetMap, /mergeRoads\(roadMeshes\.marked, "markedRoads", "marked"/);
  assert.match(openStreetMap, /mergeRoads\(roadMeshes\.pedestrian, "pedestrianRoads", "pedestrian"/);
  assert.match(openStreetMap, /mergeRoads\(roadMeshes\.dirt, "dirtRoads", "dirt"/);
  assert.match(openStreetMap, /mergeRoads\(roadMeshes\.unpaved, "unpavedRoads", "unpaved"/);
  assert.match(openStreetMap, /mergeRoads\(roadMeshes\.ford, "fordRoads", "ford"/);
  assert.match(openStreetMap, /mergeRoads\(roadShoulders\.paved, "pavedRoadShoulders", "pavedShoulder"/);
  assert.match(openStreetMap, /appearance\.visualStyle !== "dirt"/);
  assert.match(openStreetMap, /road\.visualStyle !== "dirt"/);
  assert.match(openStreetMap, /Material\.MATERIAL_ALPHABLEND/);
  assert.match(openStreetMap, /texture\.hasAlpha = visualStyle === "dirt"/);
  assert.match(openStreetMap, /visualStyle === "marked" \|\| visualStyle === "dirt"/);
  assert.match(openStreetMap, /const isJoin = Math\.hypot\(/);
  assert.match(openStreetMap, /\? radialJoinUv\(point, road\)/);
  assert.match(openStreetMap, /0\.5 \+ 0\.5 \* distance \/ radius/);
  assert.match(openStreetMap, /const dirtEdgeStart = 0\.03 \+ gravelBroad \* 0\.05/);
  assert.match(openStreetMap, /dirtEdgeAmount \* dirtEdgeAmount \* \(3 - 2 \* dirtEdgeAmount\)/);
  assert.match(openStreetMap, /\* dirtEdge\)/);
  assert.match(openStreetMap, /material\.bumpTexture = relief/);
  assert.match(openStreetMap, /LOOSE_ROAD_TEXTURE_REPEAT_METERS = 6\.7/);
  assert.match(openStreetMap, /tiledValueNoise\(x, y, ROAD_TEXTURE_SIZE/);
  assert.match(openStreetMap, /relief\.level = visualStyle === "dirt" \? 0\.12 : 0\.24/);
});

test("builds a coarse road-only layer for the far render", () => {
  assert.match(openStreetMap, /static async createRoadLayer/);
  assert.match(openStreetMap, /new TransformNode\("farRoads"/);
  assert.match(openStreetMap, /createRoad\(scene, line, terrain, options, appearance, "far"\)/);
  assert.match(openStreetMap, /Math\.max\(terrainSampleSpacing, 12 \/ options\.metersPerUnit\)/);
  assert.match(openStreetMap, /Math\.max\(appearance\.widthMeters, 3\)/);
});

test("profiles bridges independently and closes shared road endpoints", () => {
  assert.match(openStreetMap, /function bridgeElevationProfile/);
  assert.match(openStreetMap, /BRIDGE_WATER_CLEARANCE_METERS = 3/);
  assert.match(openStreetMap, /mergeRoads\(bridgeDecks, "bridgeDecks", "bridgeDeck"/);
  assert.match(openStreetMap, /function createRoadJunctions/);
  assert.match(openStreetMap, /new PolygonMeshBuilder\(\s*"roadJunction"/);
});

test("renders permanent mapped waterways as terrain-following water ribbons", () => {
  assert.match(openStreetMap, /forEachFeature\(tile, "waterway"/);
  assert.match(openStreetMap, /!isSurfaceWaterFeature\(feature\.properties\)/);
  assert.match(openStreetMap, /createWaterway\(scene, line, terrain, options, widthMeters\)/);
  assert.match(openStreetMap, /mergeWaterways\(waterways, root, options\)/);
  assert.match(openStreetMap, /conformDecalPolygon\([\s\S]*?options\.terrainSurface,[\s\S]*?true,/);
  assert.match(openStreetMap, /kind: "river"/);
  assert.doesNotMatch(openStreetMap, /const elevation = Math\.min\([\s\S]*?sampleElevation/);
});

test("retains authoritative mapped lake rings for the terrain-water pipeline", () => {
  assert.match(openStreetMap, /function waterFeatureSourceId/);
  assert.match(openStreetMap, /`water\/\$\{tile\.zoom\}\/\$\{String\(feature\.id\)\}`/);
  assert.match(openStreetMap, /static collectLakePolygons\(/);
  assert.match(openStreetMap, /sourceId: waterFeatureSourceId/);
  assert.match(openStreetMap, /lakePolygons: TerrainLakeSource\[\]/);
  assert.match(openStreetMap, /prepareLakeCandidate\(water, clipBounds\)/);
  assert.doesNotMatch(
    openStreetMap,
    /createWaterPolygon|expandLakeShoreline|prepareLakeSurfacePiece|styleLakeSurfaces|inlandWater/,
  );
});
