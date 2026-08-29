import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const barriers = readFileSync(
  new URL("../src/OpenStreetMapBarriers.ts", import.meta.url),
  "utf8",
);
const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");
const streamedTile = readFileSync(new URL("../src/StreamedTile.ts", import.meta.url), "utf8");

test("loads globally mapped linear barriers in shared parent regions", () => {
  assert.match(barriers, /private static readonly QUERY_ZOOM = 14/);
  assert.match(barriers, /private static readonly cache = new Map/);
  assert.match(
    barriers,
    /hedge\|fence\|wall\|guard_rail\|jersey_barrier\|cable_barrier\|retaining_wall/,
  );
  assert.match(barriers, /out tags geom qt/);
  assert.match(barriers, /meta\[name="overpass-url"\]/);
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

test("barriers share detailed-map lifecycle and vegetation exclusion", () => {
  assert.match(streamedTile, /barrierFeatures\?: Promise<BarrierFeature\[\]>/);
  assert.match(game, /OpenStreetMapBarriers\.createExclusionMask\(/);
  assert.match(game, /combineHorizontalExclusionMasks\(\[/);
  assert.match(game, /OpenStreetMapBarriers\.createLayer\(/);
  assert.match(game, /barrierLayer\.root\.parent = mapFeatures\.root/);
});
