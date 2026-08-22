import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settings = readFileSync(new URL("../src/SceneSettings.ts", import.meta.url), "utf8");
const controls = readFileSync(new URL("../src/SceneControls.ts", import.meta.url), "utf8");
const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");

test("defaults the fully detailed streaming window to three by three tiles", () => {
  assert.match(settings, /key: "detailTilesAcross"[\s\S]*?defaultValue: 3/);
  assert.match(settings, /key: "terrainTilesAcross"[\s\S]*?defaultValue: 17/);
  assert.match(game, /this\.sceneSettings\.value\.detailTilesAcross - 1/);
  assert.match(game, /wantDetail = ring <= this\.detailTileRadius/);
});

test("renders scene sliders from shared setting definitions", () => {
  assert.match(settings, /label: "Full detail"/);
  assert.match(settings, /label: "Far terrain"/);
  assert.match(settings, /label: "Grass density"/);
  assert.match(controls, /for \(const definition of SCENE_SETTING_DEFINITIONS\)/);
  assert.match(controls, /onSettingChange\(definition\.key, value\)/);
});

test("restores coarse terrain outside the selected detailed window", () => {
  assert.match(
    game,
    /!wantDetail && record\.nativeTerrain && !record\.detailed/,
  );
  assert.match(game, /ring > this\.detailTileRadius/);
  assert.match(game, /ring > this\.terrainTileRadius/);
});

test("grass density ranges from zero to one and refreshes loaded fields", () => {
  assert.match(settings, /key: "grassDensity"[\s\S]*?minimum: 0[\s\S]*?maximum: 1/);
  assert.match(game, /densityScale: \(\) => grassDensity/);
  assert.match(game, /private async rebuildGrassFields/);
  assert.match(game, /densityScale: \(\) => density/);
});

test("persists normalized controls through one scene settings store", () => {
  assert.match(settings, /earth\.scene-settings\.v1/);
  assert.match(settings, /storage\?\.setItem\(STORAGE_KEY, JSON\.stringify\(this\.current\)\)/);
  assert.match(game, /private changeSceneSetting\(key: SceneSettingKey, value: number\)/);
});
