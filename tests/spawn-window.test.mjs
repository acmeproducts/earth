import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { worldTileAtLocation, worldTileKey, worldTileWindowOffsetsAtLocation } from "../src/WorldGrid.ts";
const fadeSource = readFileSync(new URL("../src/LayerFades.ts", import.meta.url), "utf8");
const fadeModule = { exports: {} };
new Function("exports", ts.transpileModule(fadeSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(fadeModule.exports);
const { LayerFades } = fadeModule.exports;

const source = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("Game.ts", source, ts.ScriptTarget.Latest, true);
const method = parsed.statements.find(ts.isClassDeclaration).members
  .find((member) => member.name?.getText(parsed) === "prepareSpawnWindow");
const { outputText } = ts.transpileModule(`class Subject { ${method.getText(parsed)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
});
const Subject = new Function(
  "worldTileAtLocation", "worldTileKey", "worldTileWindowOffsetsAtLocation", "reportInitializationProgress",
  outputText + "; return Subject;",
)(worldTileAtLocation, worldTileKey, worldTileWindowOffsetsAtLocation,
  async (callback, step, progress) => callback?.(step, progress));

function fixture() {
  const subject = new Subject();
  Object.assign(subject, {
    gridLevel: 10, terrainTileRadius: 2, streamingGeneration: 1,
    sceneSettings: { value: { detailTilesAcross: 2 } },
    tiles: new Map(), layerFades: { finish() {} },
  });
  return subject;
}

test("spawn waits for every render tile and its configured detail, including wrapped longitude", async () => {
  const subject = fixture();
  const target = { lat: 45, lon: 179.999 };
  const calls = [];
  const progress = [];
  let releaseLast;
  subject.streamTile = async (id, detail) => {
    calls.push({ id, detail });
    if (calls.length === 25) await new Promise((resolve) => { releaseLast = resolve; });
    subject.tiles.set(worldTileKey(id), detail
      ? { detailed: true }
      : { farTreeField: {}, farBuildings: {}, farRoads: {} });
  };
  let completed = false;
  const pending = subject.prepareSpawnWindow(target, 1, (_, value) => progress.push(value))
    .then(() => { completed = true; });
  while (!releaseLast) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(subject.tiles.size, 24);
  releaseLast();
  await pending;
  assert.equal(subject.tiles.size, 25);
  assert.equal(calls.filter((call) => call.detail).length, 4);
  assert.equal(worldTileKey(calls[0].id), worldTileKey(worldTileAtLocation(45, 179.999, 10)));
  assert.ok(calls.some(({ id }) => id.x === 0));
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
  assert.equal(progress.at(-1), 96);
});

test("incomplete detail or distant scenery keeps startup from succeeding", async () => {
  for (const missing of ["detailed", "farRoads"]) {
    const subject = fixture();
    subject.streamTile = async (id) => {
      const record = { detailed: true, farTreeField: {}, farBuildings: {}, farRoads: {} };
      delete record[missing];
      subject.tiles.set(worldTileKey(id), record);
    };
    await assert.rejects(subject.prepareSpawnWindow({ lat: 45, lon: 10 }, 1), /did not finish generating/);
  }
});

test("startup finishes layer visibility and completion callbacks before reveal", () => {
  let visibility = 0;
  let completed = false;
  const fades = new LayerFades({ refreshShadows() {}, refreshShadowsDuringFade() {} });
  fades.begin(0, 1, (value) => { visibility = value; }, () => { completed = true; }, true);
  fades.finish();
  assert.equal(visibility, 1);
  assert.equal(completed, true);
  assert.equal(fades.size, 0);
});
