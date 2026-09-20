import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import test from "node:test";

// TerrainDetail reads WorldCover's land-cover enum, which needs transformation
// in addition to the runner's type stripping. Lerc's browser entry cannot load
// in Node and no raster is decoded here, so stub it out explicitly.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "lerc") return {
      url: "data:text/javascript,export function decode(){throw new Error('Unexpected raster decode')} export function load(){throw new Error('Unexpected raster load')}",
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/WorldCover.ts")) {
      return { format: "module", shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }) };
    }
    return nextLoad(url, context);
  },
});

const { applyTerrainDetail, upsampleTerrain, TERRAIN_RELIEF_BANDS, duneReliefAt } =
  await import("../src/terrain/TerrainDetail.ts");
const { LandCoverClass } = await import("../src/world/WorldCover.ts");
const { worldTileBounds } = await import("../src/world/WorldGrid.ts");

const METERS_PER_DEGREE = 111_320;
// A zoom-16 tile near 47°N: about 415 m across.
const TILE = { level: 16, x: 34_300, y: 23_000 };
const NATIVE_SPACING_METERS = 1.6;
const FAR_SPACING_METERS = 13;

/** Builds a synthetic tile raster with elevations from a function of (x, y) in metres. */
function terrain(tile, intervals, elevationAt) {
  const bounds = worldTileBounds(tile);
  const midLatitude = (bounds.latNorth + bounds.latSouth) / 2;
  const groundWidthMeters = (bounds.lonEast - bounds.lonWest) * METERS_PER_DEGREE *
    Math.cos(midLatitude * Math.PI / 180);
  const groundHeightMeters = (bounds.latNorth - bounds.latSouth) * METERS_PER_DEGREE;
  const width = intervals + 1;
  const height = intervals + 1;
  const elevations = new Float32Array(width * height);
  let minElevation = Infinity;
  let maxElevation = -Infinity;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const value = elevationAt(
        column / intervals * groundWidthMeters,
        row / intervals * groundHeightMeters,
      );
      elevations[row * width + column] = value;
      minElevation = Math.min(minElevation, value);
      maxElevation = Math.max(maxElevation, value);
    }
  }
  return {
    elevations,
    minElevation,
    maxElevation,
    width,
    height,
    worldTile: tile,
    generationSeed: 1,
    groundWidthMeters,
    groundHeightMeters,
    bounds,
  };
}

async function displacement(data, options = {}) {
  const before = data.elevations.slice();
  await applyTerrainDetail(data, { meshVertexSpacingMeters: NATIVE_SPACING_METERS, ...options });
  return before.map((value, index) => data.elevations[index] - value);
}

function rootMeanSquare(values) {
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum / values.length);
}

const uniformCover = (landCover) => ({ sample: () => landCover });

test("relief and sand classify each shared halo sample only once", async () => {
  const data = terrain(TILE, 32, () => 100);
  const visited = new Set();
  await applyTerrainDetail(data, { meshVertexSpacingMeters: FAR_SPACING_METERS,
    landCover: { sample(longitude, latitude) {
      const key = `${longitude}/${latitude}`;
      assert.ok(!visited.has(key), 'land-cover classification must be reused between fields');
      visited.add(key);
      return longitude < (data.bounds.lonWest + data.bounds.lonEast) / 2
        ? LandCoverClass.Sand : LandCoverClass.TreeCover;
    } },
  });
  assert.ok(visited.size > data.width * data.height, 'include the cross-tile blending halo');
  assert.ok(data.sandCoverage.some(value => value > 0 && value < 0.55));
});

test("dune crests vary across successive nominal wavelengths", () => {
  let squaredDifference = 0;
  for (let i = 0; i < 100; i++) {
    const x = 150000 + i * 3, y = 3400000 + i * 5;
    const shift = duneReliefAt(x + 72 * 0.84, y + 72 * 0.54, 1) - duneReliefAt(x, y, 1);
    squaredDifference += shift * shift;
  }
  assert.ok(Math.sqrt(squaredDifference / 100) > 0.5,
    'successive dunes must not reproduce the same translated profile');
});

test("mapped dunes have walkable relief, sand coverage, and repeatable heights", async () => {
  const dunes = terrain(TILE, 128, () => 100);
  const repeat = terrain(TILE, 128, () => 100);
  const rock = terrain(TILE, 128, () => 100);
  const duneOptions = { landCover: uniformCover(LandCoverClass.Dune) };
  await displacement(dunes, duneOptions);
  await displacement(repeat, duneOptions);
  await displacement(rock, { landCover: uniformCover(LandCoverClass.Bare) });
  assert.deepEqual(dunes.elevations, repeat.elevations);
  assert.ok(dunes.maxElevation - dunes.minElevation > 6);
  assert.ok(dunes.sandCoverage.every(value => value === 1));
  assert.ok(rock.sandCoverage.every(value => value === 0));
  assert.deepEqual(dunes.elevations, dunes.reliefReferenceElevations);
});

test("sand relief joins neighboring tiles and leaves the waterline untouched", async () => {
  const west = terrain(TILE, 64, () => 100);
  const east = terrain({ ...TILE, x: TILE.x + 1 }, 64, () => 100);
  const options = { landCover: uniformCover(LandCoverClass.Sand) };
  await displacement(west, options);
  await displacement(east, options);
  for (let row = 0; row < west.height; row++) {
    assert.ok(Math.abs(west.elevations[row * west.width + west.width - 1] -
      east.elevations[row * east.width]) < 1e-5);
  }
  const shore = await displacement(terrain(TILE, 32, () => 0.2), options);
  assert.ok(shore.every(value => value === 0));
});

test("upsampling doubles the intervals and keeps the rendered surface", () => {
  const source = terrain(TILE, 4, (x, y) => 100 + x * 0.1 + y * 0.05);
  const doubled = upsampleTerrain(source, 2);
  assert.equal(doubled.width, 9);
  assert.equal(doubled.height, 9);
  for (let row = 0; row < source.height; row++) {
    for (let column = 0; column < source.width; column++) {
      assert.equal(
        doubled.elevations[row * 2 * doubled.width + column * 2],
        source.elevations[row * source.width + column],
      );
    }
  }
  // Midpoints of a bilinear surface are the mean of the surrounding samples.
  const midpoint = doubled.elevations[1 * doubled.width + 1];
  const corners = [0, 1, source.width, source.width + 1].map((i) => source.elevations[i]);
  assert.ok(Math.abs(midpoint - corners.reduce((a, b) => a + b) / 4) < 1e-4);
  assert.equal(doubled.groundWidthMeters, source.groundWidthMeters);
  assert.equal(upsampleTerrain(source, 1), source);
});

test("upsampling refuses rasters whose shoreline is already classified", () => {
  const source = terrain(TILE, 4, () => 100);
  source.waterMask = new Uint8Array(source.elevations.length);
  assert.throws(() => upsampleTerrain(source, 2), /before its shoreline/);
});

test("relief is deterministic and bounded by the band amplitudes on flat ground", async () => {
  const first = await displacement(terrain(TILE, 64, () => 100));
  const second = await displacement(terrain(TILE, 64, () => 100));
  assert.deepEqual(first, second);
  const bound = TERRAIN_RELIEF_BANDS.reduce((sum, band) => sum + band.amplitudeMeters, 0);
  assert.ok(first.every((value) => Math.abs(value) <= bound + 1e-6));
  assert.ok(rootMeanSquare(first) > 0.1, `relief too faint: ${rootMeanSquare(first)}`);
});

test("neighbouring tiles agree exactly along their shared edge", async () => {
  const west = terrain(TILE, 64, () => 100);
  const east = terrain({ ...TILE, x: TILE.x + 1 }, 64, () => 100);
  const westRelief = await displacement(west);
  const eastRelief = await displacement(east);
  for (let row = 0; row < west.height; row++) {
    const shared = westRelief[row * west.width + west.width - 1];
    assert.ok(Math.abs(shared - eastRelief[row * east.width]) < 1e-5);
  }
});

test("relief leaves the sea bed and the waterline alone", async () => {
  const submerged = await displacement(terrain(TILE, 32, () => -5));
  const waterline = await displacement(terrain(TILE, 32, () => 0.2));
  assert.ok(submerged.every((value) => value === 0));
  assert.ok(waterline.every((value) => value === 0));
  const shore = await displacement(terrain(TILE, 32, () => 1.5));
  const inland = await displacement(terrain(TILE, 32, () => 50));
  assert.ok(rootMeanSquare(shore) > 0);
  assert.ok(rootMeanSquare(shore) < rootMeanSquare(inland) * 0.7);
});

test("bands a coarse far-tile mesh cannot reconstruct fade out", async () => {
  const fine = await displacement(terrain(TILE, 64, () => 100));
  const coarse = await displacement(
    terrain(TILE, 64, () => 100),
    { meshVertexSpacingMeters: FAR_SPACING_METERS },
  );
  const fineRms = rootMeanSquare(fine);
  const coarseRms = rootMeanSquare(coarse);
  assert.ok(coarseRms > 0.1, "the undulation band must survive on far tiles");
  assert.ok(fineRms > coarseRms * 1.05, `fine ${fineRms} vs coarse ${coarseRms}`);
  // Only the longest band survives at that spacing, so relative to its own
  // amplitude the coarse field changes far less between neighbouring samples.
  const roughness = (relief, rms) => {
    const steps = [];
    for (let index = 1; index < relief.length; index++) {
      if (index % 65 !== 0) steps.push(relief[index] - relief[index - 1]);
    }
    return rootMeanSquare(steps) / rms;
  };
  const fineRoughness = roughness(fine, fineRms);
  const coarseRoughness = roughness(coarse, coarseRms);
  assert.ok(
    coarseRoughness < fineRoughness * 0.6,
    `coarse roughness ${coarseRoughness} vs fine ${fineRoughness}`,
  );
});

test("broken slopes are rougher than gentle ground", async () => {
  const flat = await displacement(terrain(TILE, 64, () => 200));
  const steep = await displacement(terrain(TILE, 64, (x) => 200 + x * 0.6));
  assert.ok(
    rootMeanSquare(steep) > rootMeanSquare(flat) * 1.2,
    `steep ${rootMeanSquare(steep)} vs flat ${rootMeanSquare(flat)}`,
  );
});

test("land cover scales relief and water accepts none", async () => {
  const forest = await displacement(
    terrain(TILE, 64, () => 100),
    { landCover: uniformCover(LandCoverClass.TreeCover) },
  );
  const town = await displacement(
    terrain(TILE, 64, () => 100),
    { landCover: uniformCover(LandCoverClass.BuiltUp) },
  );
  const lake = await displacement(
    terrain(TILE, 64, () => 100),
    { landCover: uniformCover(LandCoverClass.Water) },
  );
  const ratio = rootMeanSquare(town) / rootMeanSquare(forest);
  assert.ok(Math.abs(ratio - 0.3) < 0.02, `built-up relief ratio ${ratio}`);
  assert.ok(lake.every((value) => value === 0));
});

test("relief strength blends across a land-cover edge instead of stepping", async () => {
  const data = terrain(TILE, 128, () => 100);
  const midLongitude = (data.bounds.lonWest + data.bounds.lonEast) / 2;
  const relief = await displacement(data, {
    landCover: { sample: (longitude) => longitude < midLongitude
      ? LandCoverClass.Water
      : LandCoverClass.TreeCover },
  });
  const columnRms = (column) => {
    const values = [];
    for (let row = 0; row < data.height; row++) values.push(relief[row * data.width + column]);
    return rootMeanSquare(values);
  };
  const edge = data.width >> 1;
  assert.ok(columnRms(edge) > 0, "the shore of the lake still carries a little relief");
  assert.ok(columnRms(edge) < columnRms(edge + 16) * 0.75);
  assert.ok(columnRms(edge + 4) < columnRms(edge + 16));
  assert.equal(columnRms(edge - 16), 0);
});

test("elevation range follows the displaced raster", async () => {
  const data = terrain(TILE, 32, () => 100);
  await applyTerrainDetail(data, { meshVertexSpacingMeters: NATIVE_SPACING_METERS });
  assert.equal(data.minElevation, Math.min(...data.elevations));
  assert.equal(data.maxElevation, Math.max(...data.elevations));
  assert.ok(data.minElevation < 100 && data.maxElevation > 100);
});

test("coarse geometry retains omitted relief for normal mapping", async () => {
  const near = terrain(TILE, 256, () => 100);
  const far = terrain(TILE, 256, () => 100);
  const spacing = Math.max(near.groundWidthMeters, near.groundHeightMeters) / 256;
  await applyTerrainDetail(near, { meshVertexSpacingMeters: spacing });
  await applyTerrainDetail(far, { meshVertexSpacingMeters: FAR_SPACING_METERS });
  assert.ok(far.shadingRelief.some(value => Math.abs(value) > 0.01));
  for (let i = 0; i < near.elevations.length; i++) {
    assert.ok(Math.abs(near.elevations[i] - far.elevations[i] - far.shadingRelief[i]) < 0.00002);
  }
});
