import assert from "node:assert/strict";
import test from "node:test";
import {
  SceneSettingsStore,
  updateSceneSetting,
} from "../src/app/SceneSettings.ts";

class MemoryStorage {
  value = null;

  getItem() {
    return this.value;
  }

  setItem(_key, value) {
    this.value = value;
  }
}

test("loads defaults and normalizes linked terrain sizes", () => {
  const store = new SceneSettingsStore(new URLSearchParams());
  assert.deepEqual(store.value, {
    modelRangeMeters: 50,
    detailTilesAcross: 2,
    terrainTilesAcross: 33,
    cloudDensity: 0.65,
    windSpeedMetersPerSecond: 14,
    showRoofs: true,
  });

  const reducedTerrain = updateSceneSetting(store.value, "terrainTilesAcross", 3);
  assert.equal(reducedTerrain.terrainTilesAcross, 3);
  assert.equal(reducedTerrain.detailTilesAcross, 2);
});

test("persists normalized values and restores them", () => {
  const storage = new MemoryStorage();
  const store = new SceneSettingsStore(new URLSearchParams(), storage);
  store.update("cloudDensity", 0.33);
  store.update("detailTilesAcross", 8);

  assert.equal(store.value.cloudDensity, 0.35);
  assert.equal(store.value.detailTilesAcross, 8);
  assert.deepEqual(new SceneSettingsStore(new URLSearchParams(), storage).value, store.value);
});

test("allows a two by two full-detail terrain window", () => {
  const store = new SceneSettingsStore(new URLSearchParams("detail-size=2"));
  assert.equal(store.value.detailTilesAcross, 2);
});

test("URL parameters override remembered settings", () => {
  const storage = new MemoryStorage();
  storage.value = JSON.stringify({
    modelRangeMeters: 20,
    detailTilesAcross: 3,
    terrainTilesAcross: 9,
    cloudDensity: 0.25,
  });
  const store = new SceneSettingsStore(new URLSearchParams(
    "vegetation-distance=75&cloud-density=0.8&wind-speed=22",
  ), storage);

  assert.equal(store.value.modelRangeMeters, 75);
  assert.equal(store.value.cloudDensity, 0.8);
  assert.equal(store.value.terrainTilesAcross, 17);
  assert.equal(store.value.windSpeedMetersPerSecond, 22);
});

test("migrates the old far range once and lets explicit tile counts override it", () => {
  const storage = new MemoryStorage();
  storage.value = JSON.stringify({ terrainTilesAcross: 17, detailTilesAcross: 2 });
  const store = new SceneSettingsStore(new URLSearchParams(), storage);
  assert.equal(store.value.terrainTilesAcross, 33);
  assert.equal(store.value.detailTilesAcross, 2);
  store.update("cloudDensity", 0.5);
  assert.equal(new SceneSettingsStore(new URLSearchParams(), storage).value.terrainTilesAcross, 33);
  assert.equal(new SceneSettingsStore(new URLSearchParams("terrain-size=9"), storage).value.terrainTilesAcross, 9);
});

test("ignores malformed stored data", () => {
  const storage = new MemoryStorage();
  storage.value = "not json";
  const store = new SceneSettingsStore(new URLSearchParams(), storage);
  assert.equal(store.value.detailTilesAcross, 2);
});
