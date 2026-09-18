import assert from 'node:assert/strict';
import test from 'node:test';
import { carveTerrainWaterways } from '../src/terrain/TerrainWaterways.ts';
import { SegmentExclusionMask } from '../src/world/Geo.ts';

const options = { meshWidth: 40, meshDepth: 40, metersPerUnit: 1 };
const river = { start: { x: 0, z: -30 }, end: { x: 0, z: 30 }, halfWidth: 6 };
function terrain() {
  return { width: 41, height: 41, elevations: new Float32Array(41 * 41).fill(50),
    minElevation: 50, maxElevation: 50 };
}
const at = (data, x, z = 0) => data.elevations[(20 - z) * 41 + x + 20];

test('high banks are cut below the level channel instead of tilting the river bed', async () => {
  const data = terrain();
  for (let row = 0; row < 41; row++) for (let column = 0; column < 41; column++) {
    data.elevations[row * 41 + column] += (column - 20) * 0.5;
  }
  await carveTerrainWaterways(data, [river], options);
  assert.equal(at(data, 0), 48.5);
  assert.equal(at(data, 6), 48.5);
  assert.ok(at(data, -6) <= 48.5);
  assert.equal(at(data, 15), 57.5);
});

test('river beds are lowered with smooth banks and untouched distant terrain', async () => {
  const data = terrain();
  await carveTerrainWaterways(data, [river], options);
  assert.equal(at(data, 0), 48.5);
  assert.equal(at(data, 6), 48.5);
  assert.ok(at(data, 7) > at(data, 6));
  assert.ok(at(data, 8) > at(data, 7));
  assert.equal(at(data, 10), 50);
  assert.equal(data.minElevation, 48.5);
  assert.equal(data.maxElevation, 50);
});

test('duplicate provider segments and confluences do not multiply carving depth', async () => {
  const data = terrain();
  await carveTerrainWaterways(data, [river, river,
    { start: { x: -30, z: 0 }, end: { x: 30, z: 0 }, halfWidth: 6 }], options);
  assert.equal(at(data, 0), 48.5);
});

test('narrow streams between grid vertices still lower the rendered terrain', async () => {
  const data = terrain();
  await carveTerrainWaterways(data, [{ start: { x: 0.5, z: -30 },
    end: { x: 0.5, z: 30 }, halfWidth: 0.4 }], options);
  assert.ok(at(data, 0) < 49.9);
  assert.equal(at(data, 0), at(data, 1));
  assert.equal(at(data, 5), 50);
});

test('river masks exclude grass footprints touching the water while retaining dry banks', () => {
  const mask = new SegmentExclusionMask([river], 20);
  assert.equal(mask.intersects(0, 0, 2), true);
  assert.equal(mask.intersects(7, 0, 2), true);
  assert.equal(mask.intersects(9, 0, 2), false);
});

test('carving is invariant under scene scale and ignores off-tile channels', async () => {
  const expected = terrain();
  const scaled = terrain();
  await carveTerrainWaterways(expected, [river], options);
  await carveTerrainWaterways(scaled, [{ start: { x: 0, z: -3 },
    end: { x: 0, z: 3 }, halfWidth: 0.6 }],
    { meshWidth: 4, meshDepth: 4, metersPerUnit: 10 });
  assert.deepEqual(scaled.elevations, expected.elevations);
  const untouched = terrain();
  await carveTerrainWaterways(untouched, [{ start: { x: 100, z: -30 },
    end: { x: 100, z: 30 }, halfWidth: 6 }], options);
  assert.ok(untouched.elevations.every(value => value === 50));
});
