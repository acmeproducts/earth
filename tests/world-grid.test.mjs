import assert from "node:assert/strict";
import test from "node:test";

const {
  layerSeed,
  WORLD_GRID_LEVEL,
  WORLD_TILE_PROJECTED_SIZE_METERS,
  worldTileAreaAtLocation,
  worldTileAreaKey,
  worldTileAtLocation,
  worldTileBounds,
  worldTileCoordinatesAtLocation,
  worldTileSeed,
  worldTileIntersectsCircle,
  worldTileWindowOffsetsAtLocation,
} = await import("../src/world/WorldGrid.ts");

test("circular streaming trims square corners but includes intersecting edge tiles", () => {
  let count = 0;
  for (let dy = -17; dy <= 17; dy++) {
    for (let dx = -17; dx <= 17; dx++) {
      if (worldTileIntersectsCircle(dx, dy, 0.5, 0.5, 16.5)) count++;
    }
  }
  assert.ok(count < 33 * 33 * 0.85);
  assert.equal(worldTileIntersectsCircle(16, 16, 0.5, 0.5, 16.5), false);
  assert.equal(worldTileIntersectsCircle(16, 0, 0.5, 0.5, 16.5), true);
  assert.equal(worldTileIntersectsCircle(17, 0, 0.9, 0.5, 16.5), true);
  assert.equal(worldTileIntersectsCircle(-17, 0, 0.1, 0.5, 16.5), true);
});

test("circular streaming covers every point inside the horizon as the player moves", () => {
  for (const fraction of [0.01, 0.25, 0.5, 0.99]) {
    for (let angle = 0; angle < Math.PI * 2; angle += 0.02) {
      const dx = Math.floor(fraction + Math.cos(angle) * 16.49);
      const dy = Math.floor(1 - fraction + Math.sin(angle) * 16.49);
      assert.ok(worldTileIntersectsCircle(dx, dy, fraction, 1 - fraction, 16.5));
    }
  }
});
test("maps a location into the fixed application-owned grid", () => {
  const latitude = 59.8888085995981;
  const longitude = 10.593090176648504;
  const tile = worldTileAtLocation(latitude, longitude);
  const bounds = worldTileBounds(tile);

  assert.equal(tile.level, WORLD_GRID_LEVEL);
  assert.ok(longitude >= bounds.lonWest && longitude < bounds.lonEast);
  assert.ok(latitude <= bounds.latNorth && latitude > bounds.latSouth);
  assert.ok(Math.abs(WORLD_TILE_PROJECTED_SIZE_METERS - 305.748) < 0.001);
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

test("projects continuous application-tile coordinates", () => {
  const tile = worldTileAtLocation(59.88, 10.59);
  const coordinates = worldTileCoordinatesAtLocation(59.88, 10.59);
  assert.equal(Math.floor(coordinates.x), tile.x);
  assert.equal(Math.floor(coordinates.y), tile.y);
  assert.deepEqual(
    worldTileCoordinatesAtLocation(0, -180),
    worldTileCoordinatesAtLocation(0, 180),
  );
});

test("describes an exact two by two streaming window", () => {
  const tile = worldTileAtLocation(59.88, 10.59);
  const bounds = worldTileBounds(tile);
  const latitude = (bounds.latNorth + bounds.latSouth) / 2;
  const longitude = bounds.lonWest + 0.75 * (bounds.lonEast - bounds.lonWest);
  const offsets = worldTileWindowOffsetsAtLocation(latitude, longitude, 2);

  assert.equal(offsets.maximumX - offsets.minimumX + 1, 2);
  assert.equal(offsets.maximumY - offsets.minimumY + 1, 2);
  assert.ok(offsets.minimumX <= 0 && offsets.maximumX >= 0);
  assert.ok(offsets.minimumY <= 0 && offsets.maximumY >= 0);
});
