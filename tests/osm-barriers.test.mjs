import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const barriers = readFileSync(
  new URL("../src/world/OpenStreetMapBarriers.ts", import.meta.url),
  "utf8",
);
const game = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
const streamedTile = readFileSync(new URL("../src/world/StreamedTile.ts", import.meta.url), "utf8");
const streetLamps = readFileSync(new URL("../src/roads/StreetLamps.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");

test("does not contact Overpass while streaming map detail", () => {
  assert.doesNotMatch(game + barriers + streetLamps + index, /overpass|api\/interpreter/i);
  assert.doesNotMatch(game, /OpenStreetMapBarriers\.fetch|StreetLamps\.fetch/);
  assert.doesNotMatch(streamedTile, /barrierFeatures/);
});

test("clips and terrain-conforms barrier geometry before committing it", () => {
  assert.match(barriers, /clipPolyline\(projected, options\.meshWidth \/ 2, options\.meshDepth \/ 2\)/);
  assert.match(barriers, /sampleElevation\(terrain/);
  assert.match(barriers, /mesh\.setEnabled\(false\)/);
  assert.match(barriers, /merged\.parent = root;[\s\S]*?merged\.setEnabled\(true\)/);
  assert.match(barriers, /feature\.tags\.wall === "noise_barrier"/);
  assert.match(barriers, /positiveMeters\(feature\.tags\.height\)/);
});

test("renders ordinary fences as chain-link and preserves wood-tagged fences", () => {
  assert.match(barriers, /style: isWoodFence\(feature\) \? "woodFence" : "chainlink"/);
  assert.match(barriers, /material\.includes\("wood"\)/);
  assert.match(barriers, /createChainlinkFence\(/);
  assert.match(barriers, /chainlinkWire/);
  assert.match(barriers, /case "woodFence"/);
  assert.match(barriers, /case "chainlink"/);
});

test("barrier renderer remains available without owning a network source", () => {
  assert.match(barriers, /static async createLayer\(/);
  assert.match(barriers, /static async createPlannedLayer\(/);
  assert.match(barriers, /static createPlannedExclusionMask\(/);
  assert.match(barriers, /static createExclusionMask\(/);
  assert.doesNotMatch(barriers, /static fetch\(|fetchRegion\(/);
});
