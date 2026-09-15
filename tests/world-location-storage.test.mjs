import assert from "node:assert/strict";
import test from "node:test";
import { WorldLocationStore } from "../src/world/Locations.ts";

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

test("a pending shortcut survives stale movement saves and is cleared after arrival", () => {
  const storage = new MemoryStorage();
  const tabStorage = new MemoryStorage();
  const target = { lat: 59.8888085995981, lon: 10.593090176648504 };
  const outgoing = new WorldLocationStore(fallback, storage, tabStorage);
  outgoing.requestDestination(target);
  outgoing.update(fallback);

  const reloaded = new WorldLocationStore(fallback, storage, tabStorage);
  assert.deepEqual(reloaded.pendingDestination, target);
  // A different tab sharing local storage must not inherit this navigation.
  assert.equal(new WorldLocationStore(fallback, storage, new MemoryStorage()).pendingDestination, undefined);
  reloaded.update(target);
  reloaded.completeDestination();
  const nextReload = new WorldLocationStore(fallback, storage, tabStorage);
  assert.equal(nextReload.pendingDestination, undefined);
  assert.deepEqual(nextReload.value, target);
});

test("invalid pending navigation is ignored", () => {
  const tabStorage = new MemoryStorage();
  for (const value of ["bad json", "null", '{"lat":90,"lon":10}']) {
    tabStorage.value = value;
    assert.equal(new WorldLocationStore(fallback, undefined, tabStorage).pendingDestination, undefined);
  }
});
