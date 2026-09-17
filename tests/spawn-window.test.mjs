import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
const fadeSource = readFileSync(new URL("../src/rendering/LayerFades.ts", import.meta.url), "utf8");
const fadeModule = { exports: {} };
new Function("exports", ts.transpileModule(fadeSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(fadeModule.exports);
const { LayerFades } = fadeModule.exports;

const source = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");

test("startup gates the spawn on the centre tile only and leaves the detail window to streaming", () => {
  const parsed = ts.createSourceFile("Game.ts", source, ts.ScriptTarget.Latest, true);
  const members = parsed.statements.find(ts.isClassDeclaration).members;
  assert.equal(members.find((member) => member.name?.getText(parsed) === "prepareSpawnWindow"), undefined);
  const loadWorld = source.slice(source.indexOf("const centerTile = worldTileAtLocation(target.lat, target.lon, this.gridLevel);"));
  const spawnSection = loadWorld.slice(0, loadWorld.indexOf("this.layerFades.finish();"));
  // Exactly one tile build is awaited before the spawn, and it is the detailed centre tile.
  assert.equal((spawnSection.match(/await this\.streamTile\(/g) ?? []).length, 1);
  assert.match(spawnSection, /await this\.streamTile\(\s*centerTile,\s*true,/);
  assert.match(spawnSection, /Spawn tile ready/);
  // The runtime scheduler still promotes the inner window to full detail.
  assert.match(source, /const needsDetail = wantDetail && !\(record\?\.detailed \?\? false\);/);
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
