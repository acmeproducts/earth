import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settings = readFileSync(new URL("../src/SceneSettings.ts", import.meta.url), "utf8");
const controls = readFileSync(new URL("../src/SceneControls.ts", import.meta.url), "utf8");
const geocoding = readFileSync(new URL("../src/Geocoding.ts", import.meta.url), "utf8");
const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const solarLighting = readFileSync(new URL("../src/SolarLighting.ts", import.meta.url), "utf8");
const gameTime = readFileSync(new URL("../src/GameTime.ts", import.meta.url), "utf8");

test("defaults to three by three and allows exact even-sized detail windows", () => {
  assert.match(settings, /key: "detailTilesAcross"[\s\S]*?defaultValue: 3/);
  assert.match(settings, /key: "detailTilesAcross"[\s\S]*?step: 1/);
  assert.match(settings, /key: "terrainTilesAcross"[\s\S]*?defaultValue: 17/);
  assert.match(game, /worldTileWindowOffsetsAtLocation\(/);
  assert.match(game, /dx >= detailWindow\.minimumX[\s\S]*?dy <= detailWindow\.maximumY/);
});

test("renders scene sliders from shared setting definitions", () => {
  assert.match(settings, /label: "Full detail"/);
  assert.match(settings, /label: "Far terrain"/);
  assert.match(settings, /label: "Cloud density"/);
  assert.match(controls, /for \(const definition of SCENE_SETTING_DEFINITIONS\)/);
  assert.match(controls, /onSettingChange\(definition\.key, value\)/);
});

test("restores coarse terrain outside the selected detailed window", () => {
  assert.match(
    game,
    /!wantDetail && record\.nativeTerrain && !record\.detailed/,
  );
  assert.match(game, /record\.detailed && !wantDetail/);
  assert.match(game, /ring > this\.terrainTileRadius/);
});

test("cloud density ranges from zero to one and refreshes the cloud layer", () => {
  assert.match(settings, /key: "cloudDensity"[\s\S]*?minimum: 0[\s\S]*?maximum: 1/);
  assert.match(game, /density: this\.cloudDensity/);
  assert.match(game, /this\.cloudLayer\?\.setDensity\(next\.cloudDensity\)/);
  assert.doesNotMatch(settings, /grassDensity|Grass density/);
});

test("the settings menu toggles with Escape and supports coordinate navigation", () => {
  assert.match(controls, /event\.key !== "Escape"/);
  assert.match(controls, /this\.setMenuOpen\(!this\.menuOpen\)/);
  assert.match(controls, /createCoordinateInput\("Longitude", -180, 180\)/);
  assert.match(controls, /onLocationChange\(location\)/);
});

test("a URL time override fixes both the sun and the settings clock", () => {
  assert.match(game, /query\.has\("time"\)/);
  assert.match(game, /queryNumber\(query, "time", 12, 0, 23\.75\)/);
  assert.match(game, /this\.solarLighting\.setTimeOfDay\(this\.initialTimeOfDay\)/);
  assert.match(controls, /initialTimeOfDay\?: number/);
  assert.match(controls, /this\.isLiveTime = false/);
});

test("live date and time share the accelerated game clock", () => {
  assert.match(gameTime, /GAME_TIME_SPEED = 24/);
  assert.match(gameTime, /new Date\(2026, 0, 1, 0, 0, 0, 0\)/);
  assert.match(solarLighting, /const date = getGameDate\(\)/);
  assert.match(controls, /const gameDate = getGameDate\(\)/);
  assert.match(controls, /CLOCK_UPDATE_INTERVAL_MS = 1_000/);
});

test("the simulation date can be fixed from the settings menu or URL", () => {
  assert.match(game, /query\.get\("date"\)/);
  assert.match(game, /this\.solarLighting\.setDate\(this\.initialDate\)/);
  assert.match(controls, /initialDate\?: string/);
  assert.match(controls, /this\.dateInput\.type = "date"/);
  assert.match(controls, /options\.onDateChange\(this\.dateInput\.value\)/);
  assert.match(controls, /options\.onDateChange\(undefined\)/);
  assert.match(solarLighting, /get currentDate\(\): Date/);
  assert.match(solarLighting, /setDate\(date\?: string\)/);
});

test("location names are geocoded and passed through coordinate navigation", () => {
  assert.match(controls, /aria-label", "Place or address"/);
  assert.match(controls, /geocodeLocationName\(this\.placeInput\.value\)/);
  assert.match(controls, /onLocationChange\(location\)/);
  assert.match(geocoding, /q: normalizedQuery/);
  assert.match(geocoding, /format: "jsonv2"/);
  assert.match(geocoding, /limit: "1"/);
  assert.match(geocoding, /REQUEST_INTERVAL_MS = 1_000/);
  assert.match(geocoding, /sessionStorage\.setItem/);
});

test("gameplay uses pointer lock and only the open menu restores the cursor", () => {
  const menuOpenHandler = game.match(
    /private setMenuOpen\([\s\S]*?(?=\n  private setupPointerLockControls)/,
  );
  assert.ok(menuOpenHandler);
  assert.match(game, /this\.canvas\.requestPointerLock\(\)/);
  assert.match(game, /document\.addEventListener\("pointerlockchange"/);
  assert.match(game, /this\.sceneControls\?\.setMenuOpen\(true\)/);
  assert.match(game, /document\.exitPointerLock\(\)/);
  assert.match(game, /classList\.toggle\("gameplay-input", !isOpen\)/);
  assert.doesNotMatch(menuOpenHandler[0], /this\.requestPointerLock\(\)/);
  assert.match(html, /body\.gameplay-input \*[\s\S]*?cursor: none !important/);
});

test("changing worlds discards the outgoing camera's local position offset", () => {
  assert.match(
    game,
    /private async startWorld\([\s\S]*?this\.resetCameraForWorldChange\(\);[\s\S]*?this\.disposeAllTiles\(\)/,
  );
  assert.match(game, /resetCameraForWorldChange\(\)[\s\S]*?position\.x = 0/);
  assert.match(game, /resetCameraForWorldChange\(\)[\s\S]*?position\.z = 0/);
  assert.match(game, /resetCameraForWorldChange\(\)[\s\S]*?cameraDirection\.setAll\(0\)/);
});

test("persists normalized controls through one scene settings store", () => {
  assert.match(settings, /earth\.scene-settings\.v1/);
  assert.match(settings, /storage\?\.setItem\(STORAGE_KEY, JSON\.stringify\(this\.current\)\)/);
  assert.match(game, /private changeSceneSetting\(key: SceneSettingKey, value: number\)/);
});
