import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const landCover = readFileSync(
  new URL("../src/OpenStreetMapLandCover.ts", import.meta.url),
  "utf8",
);

test("maps OSM natural cover to WorldCover-compatible classes", () => {
  assert.match(landCover, /\["forest", "wood"\][\s\S]*?LandCoverClass\.TreeCover/);
  assert.match(landCover, /\["heath", "scrub", "shrubbery"\][\s\S]*?LandCoverClass\.Shrubland/);
  assert.match(landCover, /\["bog", "marsh", "swamp", "wetland"\][\s\S]*?LandCoverClass\.Wetland/);
  assert.match(landCover, /"sand"[\s\S]*?LandCoverClass\.Bare/);
});

test("maps OSM land use that materially changes vegetation placement", () => {
  assert.match(landCover, /"industrial"[\s\S]*?LandCoverClass\.BuiltUp/);
  assert.match(landCover, /"pitch"[\s\S]*?LandCoverClass\.Grassland/);
  assert.doesNotMatch(landCover, /"residential"/);
});

test("prefers a more specific OSM subclass when present", () => {
  assert.match(landCover, /text\(properties\.subclass\) \?\? text\(properties\.class\)/);
});

test("checks precise OSM polygons before returning the global fallback", () => {
  assert.match(landCover, /let cover = this\.fallback\.sample\(longitude, latitude\)/);
  assert.match(landCover, /if \(contains\(region, longitude, latitude\)\) cover = region\.cover/);
  assert.match(landCover, /rings\.slice\(1\)\.some/);
});
