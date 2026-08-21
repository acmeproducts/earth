import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const openStreetMap = readFileSync(new URL("../src/OpenStreetMap.ts", import.meta.url), "utf8");

test("stages every OSM mesh out of render lists until the layer is assembled", () => {
  assert.match(openStreetMap, /function stageMapMesh<T extends Mesh>[\s\S]*?mesh\.setEnabled\(false\)/);
  assert.match(openStreetMap, /stageMapMesh\(\s*new PolygonMeshBuilder\("building"/);
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

test("styles OSM unpaved roads separately from paved roads", () => {
  assert.match(openStreetMap, /feature\.properties\.surface/);
  assert.match(openStreetMap, /track: 2\.4/);
  assert.match(openStreetMap, /type === "path" \|\| type === "track"/);
  assert.match(openStreetMap, /mergeRoads\(unpavedRoads, "unpavedRoads", "unpaved"/);
  assert.match(openStreetMap, /material\.bumpTexture = relief/);
});

test("extends lake surfaces beneath the terrain shoreline transition", () => {
  assert.match(openStreetMap, /const LAKE_SHORELINE_UNDERLAP_METERS = 35/);
  assert.match(
    openStreetMap,
    /expandPolygon\(points, LAKE_SHORELINE_UNDERLAP_METERS \/ options\.metersPerUnit\)/,
  );
  assert.ok(
    openStreetMap.indexOf("const expanded = isWater") < openStreetMap.indexOf("const clipped = clipPolygon"),
  );
});

test("merges inland water and gives it the reflective ocean material", () => {
  const styleStart = openStreetMap.indexOf("function styleWater(");
  const styleWater = openStreetMap.slice(styleStart);
  assert.match(styleWater, /Mesh\.MergeMeshes\(meshes, true, true\)/);
  assert.match(styleWater, /createWaterSurfaceMaterial\(parent\.getScene\(\)/);
  assert.match(styleWater, /skyReflection: options\.skyReflection/);
  assert.doesNotMatch(styleWater, /material\.alpha|new StandardMaterial/);
});

test("preserves the shared sky reflection when a streamed lake layer is disposed", () => {
  assert.match(openStreetMap, /static disposeLayer\(root: TransformNode\)/);
  assert.match(
    openStreetMap,
    /mesh\.material instanceof PBRMaterial\) mesh\.material\.reflectionTexture = null/,
  );
  assert.match(openStreetMap, /root\.dispose\(false, true\)/);
});
