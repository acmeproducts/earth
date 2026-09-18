import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const game = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
const streamedTile = readFileSync(new URL("../src/world/StreamedTile.ts", import.meta.url), "utf8");
const elevation = readFileSync(
  new URL("../src/terrain/TerrainElevationSource.ts", import.meta.url),
  "utf8",
);
const worldCover = readFileSync(new URL("../src/world/WorldCover.ts", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("streamed tiles own one provider-backed data bundle", () => {
  assert.match(streamedTile, /landCover\?: WorldCover/);
  assert.match(streamedTile, /preCarvingElevations: Float32Array/);
  assert.match(streamedTile, /mapTiles\?: Promise<MapTile\[\]>/);
  assert.match(game, /const preCarvingElevations = terrainData\.elevations\.slice\(\)/);
  assert.match(game, /record\.mapTiles \?\?= this\.requestMapTiles\(record\.terrainData\.bounds\)/);
  assert.match(game, /const mapTiles = previous\?\.mapTiles \?\? this\.requestMapTiles\(area\.bounds\)/);
  assert.equal((game.match(/TerrainElevationSource\.fetchWorldArea\(/g) ?? []).length, 1);
  assert.equal((game.match(/OpenStreetMap\.fetch\(/g) ?? []).length, 1);
  assert.match(worldCover, /private static decoderReady\?: Promise<void>/);
  assert.equal((worldCover.match(/Lerc\.load\(/g) ?? []).length, 1);
});

test("detail and distant layers reuse their tile's online data", () => {
  const detailStart = game.indexOf("private async buildTileDetail");
  const farTreesStart = game.indexOf("private async buildFarTrees", detailStart);
  const farBuildingsStart = game.indexOf("private buildFarBuildings", farTreesStart);
  const loadMapTilesStart = game.indexOf("private loadMapTiles", farBuildingsStart);
  const detail = game.slice(detailStart, farTreesStart);
  const farTrees = game.slice(farTreesStart, farBuildingsStart);
  const farBuildings = game.slice(farBuildingsStart, loadMapTilesStart);
  assert.ok(farBuildingsStart > farTreesStart && loadMapTilesStart > farBuildingsStart);
  assert.match(farBuildings, /buildFarMapLayer\(record, generation, "farBuildings"\)/);
  assert.match(farBuildings, /buildFarMapLayer\(record, generation, "farRoads"\)/);

  assert.match(detail, /const mapWays = await this\.loadMapTiles\(record\)/);
  assert.match(detail, /record\.landCover/);
  assert.match(detail, /preCarvingElevations: record\.preCarvingElevations/);
  assert.match(farTrees, /const mapWays = await this\.loadMapTiles\(record\)/);
  assert.match(farTrees, /record\.landCover/);
  assert.match(farBuildings, /const mapWays = await this\.loadMapTiles\(record\)/);
  assert.doesNotMatch(detail + farTrees + farBuildings, /WorldCover\.fetch|OpenStreetMap\.fetch/);
});

test("P and L environmental debug data and controls are removed", () => {
  assert.doesNotMatch(game, /DebugTerrainLayer|openTopoMap|worldCoverColors/);
  assert.doesNotMatch(game, /event\.key === "[pPlL]"/);
  assert.doesNotMatch(elevation, /OpenTopoMap|createOpenTopoMapTexture/);
  assert.doesNotMatch(elevation, /function providerTileRange/);
  assert.doesNotMatch(worldCover, /TERRAIN_COLORS|landCoverColor/);
  assert.doesNotMatch(readme, /toggled with `L`|toggled with `P`|OpenTopoMap/);
});

test("unused detail-only data aliases are removed", () => {
  assert.doesNotMatch(game, /detailLandCover|grassExclusionMask/);
});
