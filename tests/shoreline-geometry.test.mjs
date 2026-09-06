import assert from 'node:assert/strict';
import test from 'node:test';
import { createShorelineGeometry } from '../src/ShorelineGeometry.ts';

test('deep ocean and inland terrain produce no shoreline geometry', async () => {
  for (const height of [-10, 10]) {
    const result = await createShorelineGeometry([0, height, 0, 10, height, 0, 0, height, 10], [0, 1, 2], 1, 0);
    assert.equal(result.indices.length, 0);
  }
});

test('wave ribbon spans the run-up zone on a flat base for GPU displacement', async () => {
  // A beach with y = x / 10, spanning deep ocean through dry land.
  const result = await createShorelineGeometry([-30, -3, 0, 30, 3, 0, 0, 0, 30], [0, 1, 2], 1, 0);
  assert.ok(result.indices.length > 0);
  for (let i = 0; i < result.depths.length; i++) {
    const depth = result.depths[i];
    assert.ok(depth >= -1.500001 && depth <= 0.400001);
    assert.equal(result.positions[i * 3 + 1], 0);
    assert.ok(Math.abs(result.positions[i * 3] / 10 - depth) < 1e-8);
  }
  for (let i = 0; i < result.indices.length; i += 3) {
    const depths = result.indices.slice(i, i + 3).map(index => result.depths[index]);
    assert.ok(Math.max(...depths) - Math.min(...depths) <= 0.080001,
      'each incoming wave needs enough geometric samples to visibly rise and fall');
  }
});

test('geometry keeps its physical width when scene scale and water level change', async () => {
  const base = [-30, -3, 0, 30, 3, 0, 0, 0, 30];
  const normal = await createShorelineGeometry(base, [0, 1, 2], 1, 0);
  const scaled = base.map((value, index) => value / 100 + (index % 3 === 1 ? -0.01 : 0));
  const compact = await createShorelineGeometry(scaled, [0, 1, 2], 100, -0.01);
  assert.deepEqual(normal.indices, compact.indices);
  normal.depths.forEach((depth, i) => assert.ok(Math.abs(depth - compact.depths[i]) < 1e-8));
});

test('a flat triangle at sea level is emitted only once', async () => {
  const result = await createShorelineGeometry([0, 0, 0, 10, 0, 0, 0, 0, 10], [0, 1, 2], 1, 0);
  assert.equal(result.indices.length, 3);
});
