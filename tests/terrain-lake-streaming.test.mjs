import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");
const surface = readFileSync(new URL("../src/TerrainLakeSurface.ts", import.meta.url), "utf8");

test("builds lake surfaces with terrain so coarse tiles render them", () => {
  const terrainBuild = game.slice(
    game.indexOf("private async buildTileTerrain"),
    game.indexOf("private async buildTileDetail"),
  );
  assert.match(terrainBuild, /const preCarvingElevations = terrainData\.elevations\.slice\(\)/);
  assert.doesNotMatch(terrainBuild, /native \? terrainData\.elevations\.slice/);
  assert.match(terrainBuild, /createTerrainLakeLayer\(/);
  assert.match(terrainBuild, /lakeSurfaces\.root\.setEnabled\(true\)/);
});

test("carries lake surfaces through native terrain promotion", () => {
  assert.match(game, /let lakeSurfaces = previous\?\.lakeSurfaces/);
  assert.match(game, /previous\.lakeSurfaces = undefined/);
  const demotion = game.slice(
    game.indexOf("private demoteTileDetail"),
    game.indexOf("private evictCooledTiles"),
  );
  assert.doesNotMatch(demotion, /lakeSurfaces/);
});

test("renders each connected lake as one polygon mesh with attached holes", () => {
  assert.match(surface, /for \(let index = 0; index < polygons\.length; index\+\+\)/);
  assert.match(surface, /const builder = new PolygonMeshBuilder/);
  assert.match(surface, /builder\.addHole/);
  assert.match(surface, /const mesh = builder\.build\(false\)/);
  assert.doesNotMatch(surface, /Mesh\.MergeMeshes|CreateGround|CreateRibbon/);
});

test("shares the water material across far lake tiles", () => {
  assert.match(surface, /const terrainLakeMaterials = new WeakMap<Scene/);
  assert.match(surface, /terrainLakeMaterials\.get\(scene\)/);
  assert.match(surface, /terrainLakeMaterials\.set\(scene, material\)/);
});
