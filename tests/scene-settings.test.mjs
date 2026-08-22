import assert from "node:assert/strict";
import test from "node:test";
import {
  SceneSettingsStore,
  updateSceneSetting,
} from "../src/SceneSettings.ts";

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
    detailTilesAcross: 3,
    terrainTilesAcross: 17,
    grassDensity: 1,
  });

  const reducedTerrain = updateSceneSetting(store.value, "terrainTilesAcross", 3);
  assert.equal(reducedTerrain.terrainTilesAcross, 3);
  assert.equal(reducedTerrain.detailTilesAcross, 3);
});

test("persists normalized values and restores them", () => {
  const storage = new MemoryStorage();
  const store = new SceneSettingsStore(new URLSearchParams(), storage);
  store.update("grassDensity", 0.33);
  store.update("detailTilesAcross", 8);

  assert.equal(store.value.grassDensity, 0.35);
  assert.equal(store.value.detailTilesAcross, 9);
  assert.deepEqual(new SceneSettingsStore(new URLSearchParams(), storage).value, store.value);
});

test("URL parameters override remembered settings", () => {
  const storage = new MemoryStorage();
  storage.value = JSON.stringify({
    modelRangeMeters: 20,
    detailTilesAcross: 3,
    terrainTilesAcross: 9,
    grassDensity: 0.25,
  });
  const store = new SceneSettingsStore(new URLSearchParams(
    "vegetation-distance=75&grass-density=0.8",
  ), storage);

  assert.equal(store.value.modelRangeMeters, 75);
  assert.equal(store.value.grassDensity, 0.8);
  assert.equal(store.value.terrainTilesAcross, 9);
});

test("ignores malformed stored data", () => {
  const storage = new MemoryStorage();
  storage.value = "not json";
  const store = new SceneSettingsStore(new URLSearchParams(), storage);
  assert.equal(store.value.detailTilesAcross, 3);
});
