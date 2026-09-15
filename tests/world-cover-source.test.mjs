import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const worldCover = readFileSync(new URL("../src/world/WorldCover.ts", import.meta.url), "utf8");

test("uses the globally available ESA WorldCover 2021 classification", () => {
  assert.match(worldCover, /European_Space_Agency_WorldCover_2021_Land_Cover_WGS84_7/);
  assert.match(worldCover, /private static readonly RESOLUTION = 1 \/ 12_000/);
});

test("avoids invalid requests outside the source's polar extent", () => {
  assert.match(worldCover, /private static readonly MIN_LATITUDE = -60/);
  assert.match(worldCover, /private static readonly MAX_LATITUDE = 84/);
  assert.match(worldCover, /if \(west > east \|\| south > north\) return new WorldCover\(new Map\(\), resolution\)/);
});
