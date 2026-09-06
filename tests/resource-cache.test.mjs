import assert from "node:assert/strict";
import test from "node:test";
import { ResourceCache } from "../src/ResourceCache.ts";

test("travel through thousands of resources stays within the byte budget", async () => {
  const cache = new ResourceCache(32, (value) => value.byteLength);
  const live = await cache.getOrCreate("start", async () => new Uint8Array([7, 8]));
  for (let tile = 0; tile < 2000; tile++) {
    await cache.getOrCreate(String(tile), async () => new Uint8Array(8));
    assert.ok(cache.bytes <= 32);
    assert.ok(cache.size <= 4);
  }
  assert.deepEqual([...live], [7, 8], "eviction must not invalidate a live tile's data");
});

test("recently used entries survive eviction and empty responses stay bounded", async () => {
  const cache = new ResourceCache(2, () => 1);
  const create = async () => ({});
  const first = await cache.getOrCreate("a", create);
  const second = await cache.getOrCreate("b", create);
  assert.equal(await cache.getOrCreate("a", create), first);
  await cache.getOrCreate("c", create);
  assert.equal(await cache.getOrCreate("a", create), first);
  assert.notEqual(await cache.getOrCreate("b", create), second);
  const empty = new ResourceCache(32, () => 0, 4);
  for (let index = 0; index < 100; index++) await empty.getOrCreate(String(index), async () => undefined);
  assert.equal(empty.size, 4);
});

test("concurrent requests share a load and failures can retry", async () => {
  const cache = new ResourceCache(8, (value) => value.byteLength);
  let resolve;
  let loads = 0;
  const create = () => { loads++; return new Promise((done) => { resolve = done; }); };
  const first = cache.getOrCreate("a", create);
  const second = cache.getOrCreate("a", create);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(loads, 1);
  resolve(new Uint8Array(4));
  await first;
  await assert.rejects(cache.getOrCreate("failed", async () => { throw new Error("offline"); }));
  assert.equal((await cache.getOrCreate("failed", async () => new Uint8Array(2))).length, 2);
  assert.equal(cache.bytes, 6);
});

test("oversized resources are returned without being retained; pending loads stay shared", async () => {
  const cache = new ResourceCache(4, (value) => value.byteLength, 1);
  let resolve;
  const pending = cache.getOrCreate("pending", () => new Promise((done) => { resolve = done; }));
  const large = await cache.getOrCreate("large", async () => new Uint8Array(16));
  assert.equal(large.length, 16);
  assert.equal(cache.bytes, 0);
  assert.equal(cache.getOrCreate("pending", async () => { throw new Error("duplicate"); }), pending);
  resolve(new Uint8Array(2));
  await pending;
  assert.equal(cache.size, 1);
  assert.equal(cache.bytes, 2);
});
