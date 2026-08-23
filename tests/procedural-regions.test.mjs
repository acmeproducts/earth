import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-extension-resolver.mjs", import.meta.url);

const {
  proceduralRegionCandidatesAtLocation,
  proceduralRegionSpec,
  proceduralVariantAtLocation,
} = await import("../src/ProceduralRegions.ts");
const { worldTileBounds } = await import("../src/WorldGrid.ts");

function locationAtTileCoordinate(x, y) {
  const tile = { level: 16, x: Math.floor(x), y: Math.floor(y) };
  const bounds = worldTileBounds(tile);
  return {
    lon: bounds.lonWest + (x - Math.floor(x)) * (bounds.lonEast - bounds.lonWest),
    lat: bounds.latNorth + (y - Math.floor(y)) * (bounds.latSouth - bounds.latNorth),
  };
}

test("procedural families use staggered grids", () => {
  const specs = ["trees", "bushes", "grass", "flowers", "ferns"]
    .map((family) => proceduralRegionSpec(family, 128));
  assert.equal(new Set(specs.map(({ offsetX, offsetY }) => `${offsetX}/${offsetY}`)).size, 5);
  assert.ok(specs.every((spec) => spec.spanTiles === 128));
});

test("default procedural regions span 256 application tiles", () => {
  assert.equal(proceduralRegionSpec("trees").spanTiles, 256);
});

test("family transition bands remain separated on each grid axis", () => {
  const specs = ["trees", "bushes", "grass", "flowers", "ferns"]
    .map((family) => proceduralRegionSpec(family, 128));
  for (const axis of ["offsetX", "offsetY"]) {
    const offsets = specs.map((spec) => spec[axis]).sort((left, right) => left - right);
    const gaps = offsets.map((offset, index) => {
      const next = offsets[(index + 1) % offsets.length];
      return (next - offset + 128) % 128;
    });
    const reservedWidth = specs[0].blendTiles * 2 + 4;
    assert.ok(gaps.every((gap) => gap > reservedWidth));
  }
});

test("region blending is continuous and normalized across a boundary", () => {
  const boundary = 128 * 200;
  const west = locationAtTileCoordinate(boundary - 0.0001, 20_000.25);
  const east = locationAtTileCoordinate(boundary + 0.0001, 20_000.25);
  const westCandidates = proceduralRegionCandidatesAtLocation("trees", west.lon, west.lat, 42, 128);
  const eastCandidates = proceduralRegionCandidatesAtLocation("trees", east.lon, east.lat, 42, 128);

  assert.ok(Math.abs(westCandidates.reduce((sum, value) => sum + value.weight, 0) - 1) < 1e-12);
  assert.ok(Math.abs(eastCandidates.reduce((sum, value) => sum + value.weight, 0) - 1) < 1e-12);
  assert.deepEqual(westCandidates.map(({ key }) => key), eastCandidates.map(({ key }) => key));
  westCandidates.forEach((candidate, index) => {
    assert.ok(Math.abs(candidate.weight - eastCandidates[index].weight) < 0.0001);
  });
});

test("variant selection is deterministic and world-seed dependent", () => {
  const first = proceduralVariantAtLocation("bushes", 10.593, 59.889, 123, 128);
  const repeated = proceduralVariantAtLocation("bushes", 10.593, 59.889, 123, 128);
  const anotherWorld = proceduralVariantAtLocation("bushes", 10.593, 59.889, 456, 128);
  assert.deepEqual(first, repeated);
  assert.notEqual(first.seed, anotherWorld.seed);
});

test("distant regions reuse a bounded model palette without matching their neighbors", () => {
  const variants = [];
  for (let region = 0; region < 12; region++) {
    const location = locationAtTileCoordinate(region * 128 + 64, 20_000.25);
    variants.push(proceduralVariantAtLocation("trees", location.lon, location.lat, 123, 128));
  }
  assert.equal(new Set(variants.map(({ key }) => key)).size, 4);
  for (let index = 1; index < variants.length; index++) {
    assert.notEqual(variants[index].key, variants[index - 1].key);
  }
});

test("candidate regions wrap continuously at the antimeridian", () => {
  const west = proceduralRegionCandidatesAtLocation("grass", -180, 0, 99, 128);
  const east = proceduralRegionCandidatesAtLocation("grass", 180, 0, 99, 128);
  assert.deepEqual(east, west);
});
