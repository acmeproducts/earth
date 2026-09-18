import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("tile scheduling survives stopped frames and stops on disposal", () => {
  // Execute the real lifecycle methods without constructing the browser scene.
  const source = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("Game.ts", source, ts.ScriptTarget.Latest, true);
  const methods = parsed.statements.find(ts.isClassDeclaration).members
    .filter((member) => ["run", "dispose", "continueTerrainStreaming"].includes(member.name?.getText(parsed)));
  const { outputText } = ts.transpileModule(`class Subject { ${methods.map((method) => method.getText(parsed)).join("\n")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  let now = 0;
  const timers = new Map();
  let nextTimer = 0;
  let backgrounded = false;
  const Subject = new Function("setInterval", "clearInterval", "performance", "window",
    "TERRAIN_STREAMING_CHECK_INTERVAL_MS", "documentIsBackgrounded", outputText + "; return Subject;")(
    (callback, interval) => {
      assert.equal(interval, 250);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    (id) => timers.delete(id),
    { now: () => now },
    { removeEventListener() {} },
    250,
    () => backgrounded,
  );
  const subject = new Subject();
  const disposable = { dispose() {} };
  for (const key of ["roadPlanningWorker", "lakeCollectionWorker", "buildingPlanningWorker",
    "buildingCompositionWorker", "playerPresence", "fpsCounter", "scene"]) subject[key] = disposable;
  subject.engine = { ...disposable, runRenderLoop() {} };
  subject.streamingGeneration = 0;
  let scheduled = 0;
  let fades = 0;
  subject.updateTerrainStreaming = () => scheduled++;
  subject.layerFades = { update: () => fades++ };
  const tick = () => { for (const callback of timers.values()) callback(); };

  subject.run();
  subject.run();
  assert.equal(timers.size, 1, "repeated starts must not duplicate the fallback");
  for (now = 250; now <= 1000; now += 250) tick();
  assert.equal(scheduled, 4, "successive tiles can be scheduled without any rendered frames");
  assert.equal(fades, 4, "transitions can finish without rendering");

  subject.lastFrameStartMilliseconds = now;
  tick();
  assert.equal(scheduled, 4, "active rendering owns the foreground updates");
  now += 250;
  tick();
  assert.equal(scheduled, 5, "fallback resumes when frame delivery stalls again");

  backgrounded = true;
  subject.updateTerrainStreaming = (force) => {
    assert.equal(force, true, "completion must bypass the foreground polling interval");
    scheduled++;
  };
  subject.lastFrameStartMilliseconds = now;
  for (let i = 0; i < 5; i++) subject.continueTerrainStreaming(0);
  assert.equal(scheduled, 10, "completions drain the hidden queue without timer or frame callbacks");
  subject.continueTerrainStreaming(-1);
  assert.equal(scheduled, 10, "a cancelled world must not advance the current queue");

  subject.dispose();
  assert.equal(timers.size, 0);
  now += 1000;
  tick();
  subject.continueTerrainStreaming(1);
  assert.equal(scheduled, 10);
  assert.equal(subject.streamingGeneration, 1);
});

test("completed tiles refill the real scheduler without a second timer tick", async () => {
  const source = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("Game.ts", source, ts.ScriptTarget.Latest, true);
  const methods = parsed.statements.find(ts.isClassDeclaration).members
    .filter((member) => ["updateTerrainStreaming", "continueTerrainStreaming"].includes(member.name?.getText(parsed)));
  const { outputText } = ts.transpileModule(`class Subject { ${methods.map(method => method.getText(parsed)).join("\n")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  const key = id => `${id.x}/${id.y}`;
  const { worldTileIntersectsCircle } = await import("../src/world/WorldGrid.ts");
  const bindings = {
    performance: { now: () => 1000 },
    documentIsBackgrounded: () => true,
    TERRAIN_STREAMING_CHECK_INTERVAL_MS: 250,
    DETAIL_COOLDOWN_MS: 1000,
    MAX_CONCURRENT_FAR_TILE_BUILDS: 2,
    sceneToLonLat: () => ({ lon: 0, lat: 0 }),
    worldTileAtLocation: () => ({ level: 3, x: 4, y: 4 }),
    worldTileCoordinatesAtLocation: () => ({ x: 4.5, y: 4.5 }),
    worldTileIntersectsCircle,
    worldTileKey: key,
    worldTileWindowOffsetsAtLocation: () => ({ minimumX: -1, maximumX: 1, minimumY: -1, maximumY: 1 }),
  };
  const Subject = new Function(...Object.keys(bindings), outputText + "; return Subject;")(...Object.values(bindings));
  const subject = new Subject();
  Object.assign(subject, {
    streamingGeneration: 1, terrainStreamingTimer: 1, sceneryRevision: 0,
    lastTerrainStreamingCheckMilliseconds: 0, terrainTileRadius: 1,
    terrainCoordinateFrame: {}, flyCamera: { position: { x: 0, z: 0 } },
    worldLocation: { update() {} }, sceneSettings: { value: { detailTilesAcross: 3 } },
    tiles: new Map(), activeTileBuilds: new Map(), activeDetailBuilds: new Set(),
    recenterWater() {}, evictCooledTiles() {}, layerFades: { update() {} },
  });
  subject.streamTile = async (id) => {
    const tileKey = key(id);
    subject.activeTileBuilds.set(tileKey, 1);
    subject.activeDetailBuilds.add(tileKey);
    await Promise.resolve();
    subject.tiles.set(tileKey, { nativeTerrain: true, detailed: true, sceneryRevision: 0 });
    subject.activeTileBuilds.delete(tileKey);
    subject.activeDetailBuilds.delete(tileKey);
  };
  subject.updateTerrainStreaming();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(subject.tiles.size, 9);
  assert.equal(subject.activeTileBuilds.size, 0);
});
