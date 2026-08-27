import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("./ts-extension-resolver.mjs", import.meta.url);
const { hasWinterGroundCover } = await import("../src/TreeSeason.ts");

test("winter ground cover follows the hemisphere", () => {
  assert.equal(hasWinterGroundCover(new Date(2026, 0, 15), 60), true);
  assert.equal(hasWinterGroundCover(new Date(2026, 0, 15), -60), false);
  assert.equal(hasWinterGroundCover(new Date(2026, 6, 15), 60), false);
  assert.equal(hasWinterGroundCover(new Date(2026, 6, 15), -60), true);
});

test("tropical and invalid locations do not receive seasonal snow", () => {
  assert.equal(hasWinterGroundCover(new Date(2026, 0, 15), 10), false);
  assert.equal(hasWinterGroundCover(undefined, 60), false);
  assert.equal(hasWinterGroundCover(new Date(Number.NaN), 60), false);
});
