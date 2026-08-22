import assert from "node:assert/strict";
import test from "node:test";
import { WorldLocationStore } from "../src/Locations.ts";

class MemoryStorage {
  value = null;

  getItem() {
    return this.value;
  }

  setItem(_key, value) {
    this.value = value;
  }
}

const fallback = { lat: 58.79605454187253, lon: 11.182361556113896 };

test("persists and restores a world location", () => {
  const storage = new MemoryStorage();
  const store = new WorldLocationStore(fallback, storage);
  store.update({ lat: 59.91, lon: 10.75 });

  assert.deepEqual(new WorldLocationStore(fallback, storage).value, {
    lat: 59.91,
    lon: 10.75,
  });
});

test("falls back when the stored location is malformed or outside the world", () => {
  const storage = new MemoryStorage();

  for (const value of [
    "not json",
    JSON.stringify({ lat: 90, lon: 10 }),
    JSON.stringify({ lat: 59, lon: 181 }),
    JSON.stringify({ lat: "59", lon: 10 }),
  ]) {
    storage.value = value;
    assert.deepEqual(new WorldLocationStore(fallback, storage).value, fallback);
  }
});

test("ignores invalid runtime locations", () => {
  const storage = new MemoryStorage();
  const store = new WorldLocationStore(fallback, storage);
  store.update({ lat: Number.NaN, lon: 10 });

  assert.deepEqual(store.value, fallback);
  assert.equal(storage.value, null);
});
