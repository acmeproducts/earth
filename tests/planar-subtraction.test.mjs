import test from 'node:test';
import assert from 'node:assert/strict';
import { subtractConvex, polygonArea } from '../src/core/PlanarGeometry.ts';

const square = (x, z, size) => [{ x, z }, { x: x + size, z },
  { x: x + size, z: z + size }, { x, z: z + size }];

test('convex subtraction does not duplicate polygons inside the clipping tolerance', () => {
  for (const size of [1, 1e-4, 1e-5]) {
    const subject = square(2, 3, size);
    assert.equal(subtractConvex(subject, subject).reduce((sum, p) => sum + polygonArea(p), 0), 0);
  }
});

test('small convex cuts conserve area', () => {
  const subject = square(0, 0, 1e-5);
  const clip = square(5e-6, 5e-6, 1e-5);
  const pieces = subtractConvex(subject, clip);
  const area = pieces.reduce((sum, p) => sum + polygonArea(p), 0);
  assert.ok(Math.abs(area - 7.5e-11) < 1e-20);
});
