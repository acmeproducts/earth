import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { registerHooks, stripTypeScriptTypes } from "node:module";

const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "lerc") return {
      url: "data:text/javascript,export function decode(){throw new Error('Unexpected raster decode')} export function load(){throw new Error('Unexpected raster load')}",
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/WorldCover.ts")) return {
      format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }),
    };
    return nextLoad(url, context);
  },
});
const { createOpenStreetMapLandCover } = await import("../src/world/OpenStreetMapLandCover.ts");
hook.deregister();

test("reuses decoded provider polygons while retaining independent fallbacks", async () => {
  let decodes = 0;
  const data = { layers: { landcover: { length: 1, feature: () => ({
    properties: { class: "forest" },
    toGeoJSON: () => { decodes++; return { geometry: { type: "Polygon", coordinates: [
      [[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]],
    ] } }; },
  }) } } };
  const tile = { x: 0, y: 0, zoom: 0, data };
  const first = createOpenStreetMapLandCover([tile], { sample: () => 123 });
  const second = createOpenStreetMapLandCover([{ ...tile }], { sample: () => 456 });
  assert.equal(decodes, 1);
  assert.equal(first.sample(0, 0), second.sample(0, 0));
  assert.notEqual(first.sample(0, 0), 123);
  assert.equal(first.sample(20, 20), 123);
  assert.equal(second.sample(20, 20), 456);
  createOpenStreetMapLandCover([{ ...tile, x: 1 }], { sample: () => 123 });
  assert.equal(decodes, 2, "different coordinates require a new projection");
  createOpenStreetMapLandCover([{ ...tile, data: { ...data } }], { sample: () => 123 });
  assert.equal(decodes, 3, "replacement data must invalidate decoded polygons");
});

const landCover = readFileSync(
  new URL("../src/world/OpenStreetMapLandCover.ts", import.meta.url),
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
  assert.match(landCover, /"farmland"[\s\S]*?LandCoverClass\.Cropland/);
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
