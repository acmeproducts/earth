import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { PolygonExclusionMask } = await import("../src/Geo.ts");

const mask = new PolygonExclusionMask([{
  outer: [
    { x: -5, z: -5 },
    { x: 5, z: -5 },
    { x: 5, z: 5 },
    { x: -5, z: 5 },
  ],
  holes: [[
    { x: -2, z: -2 },
    { x: 2, z: -2 },
    { x: 2, z: 2 },
    { x: -2, z: 2 },
  ]],
}]);

test("excludes vegetation centered inside a building footprint", () => {
  assert.equal(mask.intersects(4, 0, 0.25), true);
});

test("excludes vegetation whose rendered footprint reaches a building wall", () => {
  assert.equal(mask.intersects(5.8, 0, 1), true);
  assert.equal(mask.intersects(6.2, 0, 1), false);
});

test("preserves open courtyards until vegetation overlaps their walls", () => {
  assert.equal(mask.intersects(0, 0, 1), false);
  assert.equal(mask.intersects(0, 0, 2.1), true);
});

test("builds the shared vegetation mask from OSM building footprints", () => {
  const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");
  const openStreetMap = readFileSync(
    new URL("../src/OpenStreetMap.ts", import.meta.url),
    "utf8",
  );
  assert.match(game, /OpenStreetMap\.createVegetationExclusionMask\(/);
  assert.match(openStreetMap, /source\.polygon\.outer\.map\(project\)/);
  assert.match(openStreetMap, /new PolygonExclusionMask\(/);
});
