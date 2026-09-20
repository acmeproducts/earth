import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/WorldCover.ts')) return {
      format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }),
    };
    return nextLoad(url, context);
  },
});
const { createTerrainSurfaceColors } = await import('../src/terrain/TerrainSurfaceColors.ts');
hook.deregister();

function terrain(west = 0) {
  return {
    groundWidthMeters: 192, groundHeightMeters: 192,
    bounds: { lonWest: west, lonEast: west + 0.002, latSouth: 0, latNorth: 0.002 },
  };
}

test('near and far grids sample the same physical color field', async () => {
  const cover = { sample: () => 30, sampleSurfaceColor: lon => lon < 0.001 ? [0.2, 0.6, 0.3] : [0.8, 0.7, 0.5] };
  const sample = await createTerrainSurfaceColors(terrain(), cover);
  const near = Array.from({ length: 257 }, (_, i) => sample(i / 256, 0.5));
  const far = Array.from({ length: 33 }, (_, i) => sample(i / 32, 0.5));
  far.forEach((color, i) => assert.deepEqual(color, near[i * 8]));
  assert.ok(sample(0.5, 0.5)[0] > 0.2 && sample(0.5, 0.5)[0] < 0.8);
  assert.ok(Math.abs(sample(0.25, 0.5)[0] - 0.2) < 1e-6);
});

test('tile boundary colors include land cover on both sides', async () => {
  const cover = { sample: () => 30, sampleSurfaceColor: lon => [0.2 + lon * 100, 0.6, 0.3] };
  const west = await createTerrainSurfaceColors(terrain(), cover);
  const east = await createTerrainSurfaceColors(terrain(0.002), cover);
  for (const v of [0, 0.25, 0.5, 1]) {
    west(1, v).forEach((value, channel) => assert.ok(Math.abs(value - east(0, v)[channel]) < 1e-6));
    assert.ok(Math.abs(west(1, v)[0] - 0.4) < 1e-6);
  }
});

test('constant surfaces retain their tint including corners and non-square tiles', async () => {
  const sample = await createTerrainSurfaceColors({ ...terrain(), groundHeightMeters: 97 },
    { sample: () => 30, sampleSurfaceColor: () => [0.25, 0.5, 0.75] });
  for (const u of [0, 0.4, 1]) for (const v of [0, 0.7, 1]) {
    assert.deepEqual(sample(u, v), [0.25, 0.5, 0.75]);
  }
});
