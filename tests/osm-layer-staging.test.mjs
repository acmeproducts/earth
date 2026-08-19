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
