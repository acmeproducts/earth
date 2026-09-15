import assert from "node:assert/strict";
import test from "node:test";
import { OwnedValueCache } from "../src/core/OwnedValueCache.ts";

test("shared values remain until their last streamed owner releases them", () => {
  const cache = new OwnedValueCache();
  const firstOwner = {};
  const secondOwner = {};
  const first = cache.forOwner(firstOwner);
  const second = cache.forOwner(secondOwner);

  first.set("edge", 12);
  assert.equal(second.get("edge"), 12);
  assert.equal(cache.size, 1);
  cache.release(firstOwner);
  assert.equal(cache.size, 1);
  cache.release(secondOwner);
  assert.equal(cache.size, 0);
});

test("unshared values are pruned with their tile owner", () => {
  const cache = new OwnedValueCache();
  const owner = {};
  cache.forOwner(owner).set("lake", 8);
  cache.release(owner);
  assert.equal(cache.size, 0);
});
