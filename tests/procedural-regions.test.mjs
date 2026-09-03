import assert from "node:assert/strict";
import test from "node:test";


const {
  proceduralLocalVariantAtLocation,
  proceduralRegionCandidatesAtLocation,
  proceduralRegionSpec,
  proceduralVariantAtLocation,
} = await import("../src/procedural/ProceduralRegions.ts");
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
  const specs = ["trees", "bushes", "grass", "ferns", "tallPlants"]
    .map((family) => proceduralRegionSpec(family, 128));
  assert.equal(new Set(specs.map(({ offsetX, offsetY }) => `${offsetX}/${offsetY}`)).size, 5);
  assert.ok(specs.every((spec) => spec.spanTiles === 128));
});

test("default procedural regions span 256 application tiles", () => {
  assert.equal(proceduralRegionSpec("trees").spanTiles, 256);
});

test("family transition bands remain separated on each grid axis", () => {
  const specs = ["trees", "bushes", "grass", "ferns", "tallPlants"]
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

test("every distant region receives unique deterministic geometry", () => {
  for (const family of ["trees", "bushes", "grass", "ferns", "tallPlants", "rocks"]) {
    const variants = [];
    for (let region = 0; region < 12; region++) {
      const location = locationAtTileCoordinate(region * 128 + 64, 20_000.25);
      variants.push(proceduralVariantAtLocation(family, location.lon, location.lat, 123, 128));
    }
    assert.equal(new Set(variants.map(({ key }) => key)).size, variants.length, family);
    assert.equal(new Set(variants.map(({ seed }) => seed)).size, variants.length, family);
    assert.ok(variants.every(({ key }) => key.startsWith(`${family}/region/`)));
  }
});

test("candidate regions wrap continuously at the antimeridian", () => {
  const west = proceduralRegionCandidatesAtLocation("grass", -180, 0, 99, 128);
  const east = proceduralRegionCandidatesAtLocation("grass", 180, 0, 99, 128);
  assert.deepEqual(east, west);
});

/** Samples one application tile the way a streamed vegetation field would. */
function sisterModelsInTile(x, y, sisterModels, worldSeed = 0x1234abcd) {
  const bounds = worldTileBounds({ level: 16, x, y });
  const seen = new Set();
  for (let row = 0; row < 6; row++) {
    for (let column = 0; column < 6; column++) {
      const lon = bounds.lonWest
        + ((column + 0.5) / 6) * (bounds.lonEast - bounds.lonWest);
      const lat = bounds.latSouth
        + ((row + 0.5) / 6) * (bounds.latNorth - bounds.latSouth);
      seen.add(proceduralLocalVariantAtLocation(
        "bushes",
        lon,
        lat,
        worldSeed,
        sisterModels,
      ));
    }
  }
  return seen;
}

test("one tile normally builds a single sister model", () => {
  // Every sister model alive in a tile costs its own impostor atlas capture and
  // its own live mesh, so the whole point of binding the choice to the locality
  // is that a tile pays for one. Rolling it per placement pays for all of them.
  const counts = new Map();
  let tiles = 0;
  for (let y = 24_000; y < 24_060; y++) {
    for (let x = 34_000; x < 34_060; x++) {
      const size = sisterModelsInTile(x, y, 3).size;
      counts.set(size, (counts.get(size) ?? 0) + 1);
      tiles++;
    }
  }
  assert.ok(counts.get(1) / tiles > 0.8, `single-model tiles ${counts.get(1)}/${tiles}`);
  assert.ok((counts.get(3) ?? 0) < tiles * 0.01, `all-three tiles ${counts.get(3)}/${tiles}`);
});

test("sister models are location-bound and cover the whole palette", () => {
  const location = locationAtTileCoordinate(34_000.5, 24_000.5);
  const repeated = proceduralLocalVariantAtLocation("bushes", location.lon, location.lat, 7, 3);
  assert.equal(
    proceduralLocalVariantAtLocation("bushes", location.lon, location.lat, 7, 3),
    repeated,
  );

  // Localities are wide, so the palette only proves itself over a long walk.
  const used = new Set();
  for (let x = 34_000; x < 34_600; x += 8) {
    for (const model of sisterModelsInTile(x, 24_000, 3)) used.add(model);
  }
  assert.deepEqual([...used].sort(), [0, 1, 2]);

  for (const family of ["bushes", "tallPlants"]) {
    assert.equal(proceduralLocalVariantAtLocation(family, 12, 45, 7, 1), 0);
    assert.equal(proceduralLocalVariantAtLocation(family, 12, 45, 7), 0);
  }
});

test("sister model localities wrap continuously at the antimeridian", () => {
  assert.equal(
    proceduralLocalVariantAtLocation("bushes", 180, 12, 99, 3),
    proceduralLocalVariantAtLocation("bushes", -180, 12, 99, 3),
  );
});
