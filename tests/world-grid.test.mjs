import assert from "node:assert/strict";
import test from "node:test";
import {
  layerSeed,
  WORLD_GRID_LEVEL,
  WORLD_TILE_PROJECTED_SIZE_METERS,
  worldTileAreaAtLocation,
  worldTileAreaKey,
  worldTileAtLocation,
  worldTileBounds,
  worldTileSeed,
} from "../src/WorldGrid.ts";

test("maps a location into the fixed application-owned grid", () => {
  const latitude = 59.8888085995981;
  const longitude = 10.593090176648504;
  const tile = worldTileAtLocation(latitude, longitude);
  const bounds = worldTileBounds(tile);

  assert.equal(tile.level, WORLD_GRID_LEVEL);
  assert.ok(longitude >= bounds.lonWest && longitude < bounds.lonEast);
  assert.ok(latitude <= bounds.latNorth && latitude > bounds.latSouth);
  assert.ok(Math.abs(WORLD_TILE_PROJECTED_SIZE_METERS - 2445.985) < 0.001);
});

test("wraps tile identity continuously across the antimeridian", () => {
  const west = worldTileAtLocation(0, -180);
  const east = worldTileAtLocation(0, 180);
  assert.deepEqual(east, west);
});

test("derives stable tile and independent layer seeds", () => {
  const tile = worldTileAtLocation(59.88, 10.59);
  const sameTile = worldTileAtLocation(59.88, 10.59);
  const neighbor = { ...tile, x: tile.x + 1 };
  const seed = worldTileSeed(tile, 12345);

  assert.equal(seed, worldTileSeed(sameTile, 12345));
  assert.notEqual(seed, worldTileSeed(neighbor, 12345));
  assert.notEqual(layerSeed(seed, "trees"), layerSeed(seed, "grass"));
});

test("describes a world area independently of provider tiles", () => {
  const area = worldTileAreaAtLocation(59.88, 10.59, 3, 12345);
  const smallerArea = worldTileAreaAtLocation(59.88, 10.59, 1, 12345);
  assert.equal(area.tilesAcross, 3);
  assert.equal(area.start.level, WORLD_GRID_LEVEL);
  assert.ok(area.bounds.lonWest < area.bounds.lonEast);
  assert.ok(area.bounds.latSouth < area.bounds.latNorth);
  assert.equal(area.seed, smallerArea.seed);
});

test("selects the four closest tiles and changes the window at tile midlines", () => {
  const tile = worldTileAtLocation(59.88, 10.59);
  const bounds = worldTileBounds(tile);
  const latitude = (bounds.latNorth + bounds.latSouth) / 2;
  const west = worldTileAreaAtLocation(latitude, bounds.lonWest + 0.25 * (bounds.lonEast - bounds.lonWest), 2);
  const east = worldTileAreaAtLocation(latitude, bounds.lonWest + 0.75 * (bounds.lonEast - bounds.lonWest), 2);

  assert.equal(west.tilesAcross, 2);
  assert.equal(west.start.x, tile.x - 1);
  assert.equal(east.start.x, tile.x);
  assert.notEqual(worldTileAreaKey(west), worldTileAreaKey(east));
});
