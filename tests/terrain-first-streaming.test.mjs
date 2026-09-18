import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { worldTileIntersectsCircle } from "../src/world/WorldGrid.ts";

const source = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("Game.ts", source, ts.ScriptTarget.Latest, true);
function subject(methodNames, globals) {
  const methods = parsed.statements.find(ts.isClassDeclaration).members
    .filter(member => methodNames.includes(member.name?.getText(parsed)));
  const { outputText } = ts.transpileModule(`class Subject { ${methods.map(method => method.getText(parsed)).join("\n")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  const Subject = new Function(...Object.keys(globals), outputText + "; return Subject;")(...Object.values(globals));
  return new Subject();
}
const key = id => `${id.x}/${id.y}`;

test("full detail follows a moving circle and demotes excluded corners after cooldown", () => {
  let fractionX = 0.5;
  const demoted = [];
  const game = subject(["updateTerrainStreaming", "evictCooledTiles"], {
    performance: { now: () => 40000 }, TERRAIN_STREAMING_CHECK_INTERVAL_MS: 250,
    TILE_COOLDOWN_MS: 30000, DETAIL_COOLDOWN_MS: 10000, RETAINED_TILE_EDGE_SLACK: 2,
    MAX_CONCURRENT_FAR_TILE_BUILDS: 2,
    sceneToLonLat: () => ({ lat: 0, lon: 0 }),
    worldTileAtLocation: () => ({ x: 10, y: 10, level: 5 }), worldTileKey: key,
    worldTileCoordinatesAtLocation: () => ({ x: 10 + fractionX, y: 10.5 }),
    worldTileIntersectsCircle,
  });
  Object.assign(game, { terrainCoordinateFrame: {}, flyCamera: { position: { x: 0, z: 0 } },
    worldLocation: { update() {} }, cameraTileKey: "10/10", water: {}, streamingGeneration: 1,
    sceneSettings: { value: { detailTilesAcross: 9 } }, terrainTileRadius: 6,
    activeTileBuilds: new Map(), activeDetailBuilds: new Set(["busy"]),
    tiles: new Map(), sceneryRevision: 0, refreshShadowCasters() {},
    demoteTileDetail(record) { demoted.push(record.key); record.detailed = false; },
  });
  for (const [x, y, lastNeeded] of [[14, 14, 0], [14, 10, 0], [15, 10, 0], [6, 6, 35000]]) {
    game.tiles.set(`${x}/${y}`, { key: `${x}/${y}`, id: { x, y, level: 5 },
      detailed: true, nativeTerrain: true, sceneryRevision: 0,
      detailLastNeededMilliseconds: lastNeeded, lastNeededMilliseconds: 0,
      farTreeField: {}, farBuildings: {}, farRoads: {} });
  }
  game.updateTerrainStreaming(true);
  assert.deepEqual(demoted, ["14/14", "15/10"]);
  assert.equal(game.tiles.get("14/10").detailLastNeededMilliseconds, 40000);
  assert.equal(game.tiles.get("6/6").detailed, true, "detail cooldown prevents immediate demotion");
  fractionX = 0.9;
  game.updateTerrainStreaming(true);
  assert.equal(game.tiles.get("15/10").detailLastNeededMilliseconds, 40000,
    "moving within a tile brings the next edge tile into the detail circle");
  assert.equal(game.tiles.get("14/14").detailLastNeededMilliseconds, 0);
});

test("eviction releases square corners outside the circular footprint after cooldown", () => {
  const disposed = [];
  const game = subject(["evictCooledTiles"], {
    TILE_COOLDOWN_MS: 30000, DETAIL_COOLDOWN_MS: 10000, RETAINED_TILE_EDGE_SLACK: 2,
    disposeStreamedTile: record => disposed.push(record.key),
  });
  const record = (x, y, lastNeededMilliseconds) => ({
    id: { x, y, level: 7 }, key: `${x}/${y}`, lastNeededMilliseconds, detailed: false,
  });
  const records = [record(66, 66, 0), record(66, 50, 0), record(65, 66, 35000)];
  Object.assign(game, { tiles: new Map(records.map(item => [item.key, item])),
    activeTileBuilds: new Map(), terrainTileRadius: 16 });
  game.evictCooledTiles(40000, new Set(), new Set(["66/50"]));
  assert.deepEqual(disposed, ["66/66"]);
  assert.ok(game.tiles.has("66/50"), "keep needed edge tiles");
  assert.ok(game.tiles.has("65/66"), "respect cooldown for recently needed tiles");
});

test("foreground completions refill on the next frame without a recursive build", () => {
  const game = subject(["continueTerrainStreaming"], {
    performance: { now: () => 1000 }, TERRAIN_STREAMING_CHECK_INTERVAL_MS: 250,
    documentIsBackgrounded: () => false,
  });
  Object.assign(game, { streamingGeneration: 1, terrainStreamingTimer: 1,
    lastFrameStartMilliseconds: 999, lastTerrainStreamingCheckMilliseconds: 999,
    updateTerrainStreaming() { throw new Error("Must yield to rendering first"); } });
  game.continueTerrainStreaming(0);
  assert.equal(game.lastTerrainStreamingCheckMilliseconds, 999, "ignore a cancelled build");
  game.continueTerrainStreaming(1);
  assert.equal(game.lastTerrainStreamingCheckMilliseconds, -Infinity);
});

test("terrain pass releases its slot before scenery, and the next pass finishes scenery", async () => {
  const game = subject(["streamTile"], {
    worldTileKey: key,
    StreamingTrace: class { stage() {} finish() {} },
  });
  Object.assign(game, { activeTileBuilds: new Map(), activeDetailBuilds: new Set(),
    tiles: new Map(), streamingGeneration: 1, sceneryRevision: 0 });
  const calls = [];
  game.buildTileTerrain = async id => {
    calls.push("terrain");
    const record = { sceneryRevision: 0, nativeTerrain: false };
    game.tiles.set(key(id), record);
    return record;
  };
  for (const [method, field] of [["buildFarTrees", "farTreeField"],
    ["buildFarBuildings", "farBuildings"], ["buildFarRoads", "farRoads"]]) {
    game[method] = async record => { calls.push(field); record[field] = {}; };
  }
  const id = { x: 10, y: 10 };
  await game.streamTile(id, false, 1, undefined, undefined, true);
  assert.deepEqual(calls, ["terrain"]);
  assert.equal(game.activeTileBuilds.size, 0);
  await game.streamTile(id, false, 1);
  assert.deepEqual(calls, ["terrain", "farTreeField", "farBuildings", "farRoads"]);
  assert.equal(game.activeTileBuilds.size, 0);
});

test("scheduler fills missing terrain before far scenery and still prioritizes nearby detail", async () => {
  const game = subject(["updateTerrainStreaming"], {
    performance: { now: () => 20000 }, TERRAIN_STREAMING_CHECK_INTERVAL_MS: 250,
    DETAIL_COOLDOWN_MS: 10000, MAX_CONCURRENT_FAR_TILE_BUILDS: 2,
    sceneToLonLat: () => ({ lat: 0, lon: 0 }),
    worldTileAtLocation: () => ({ x: 10, y: 10, level: 5 }), worldTileKey: key,
    worldTileCoordinatesAtLocation: () => ({ x: 10.5, y: 10.5 }),
    worldTileIntersectsCircle,
  });
  const complete = () => ({ nativeTerrain: false, detailed: false, sceneryRevision: 0,
    farTreeField: {}, farBuildings: {}, farRoads: {} });
  Object.assign(game, { terrainCoordinateFrame: {}, flyCamera: { position: { x: 0, z: 0 } },
    worldLocation: { update() {} }, cameraTileKey: "10/10", water: {}, streamingGeneration: 1,
    sceneSettings: { value: { detailTilesAcross: 1 } }, terrainTileRadius: 1,
    activeTileBuilds: new Map(), activeDetailBuilds: new Set(), tiles: new Map(), sceneryRevision: 0,
    evictCooledTiles() {}, continueTerrainStreaming() {} });
  for (let x = 9; x <= 11; x++) for (let y = 9; y <= 11; y++) game.tiles.set(`${x}/${y}`, complete());
  Object.assign(game.tiles.get("10/10"), { nativeTerrain: true, detailed: true });
  game.tiles.get("9/10").farTreeField = undefined;
  game.tiles.delete("11/11");
  const calls = [];
  game.streamTile = (id, detail, generation, progress, ready, terrainOnly) => {
    calls.push({ key: key(id), detail, terrainOnly });
    game.activeTileBuilds.set(key(id), generation);
    if (detail) game.activeDetailBuilds.add(key(id));
    return Promise.resolve();
  };
  game.updateTerrainStreaming(true);
  assert.deepEqual(calls, [
    { key: "11/11", detail: false, terrainOnly: true },
    { key: "9/10", detail: false, terrainOnly: false },
  ]);
  calls.length = 0;
  game.activeTileBuilds.clear();
  game.tiles.get("10/10").detailed = false;
  game.updateTerrainStreaming(true);
  assert.deepEqual(calls, [{ key: "10/10", detail: true, terrainOnly: false }]);
  await Promise.resolve();
});
