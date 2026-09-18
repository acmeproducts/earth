import assert from 'node:assert/strict';
import test from 'node:test';
import { riverFlowSign, riverSurfaceFrame, riverSurfaceLevels } from '../src/water/RiverSurface.ts';

test('water levels preserve a steady grade and smooth local bed bumps', () => {
  const points = Array.from({ length: 41 }, (_, x) => ({ x, z: 0 }));
  const steady = riverSurfaceLevels(points, p => 20 - p.x * 0.1, 6);
  for (let i = 0; i < points.length; i++) assert.ok(Math.abs(steady[i] - (20 - i * 0.1)) < 1e-10);
  const bumpy = riverSurfaceLevels(points, p => 20 - p.x * 0.1 + (p.x === 20 ? 1 : 0), 6);
  assert.ok(bumpy[20] - steady[20] < 0.2);
  assert.equal(bumpy[0], steady[0]);
  assert.equal(bumpy[40], steady[40]);
});

test('river current follows the overall downhill grade even through small uphill DEM bumps', () => {
  const points = Array.from({ length: 5 }, (_, x) => ({ x, z: 0 }));
  const heights = [10, 8, 8.2, 5, 3];
  assert.equal(riverFlowSign(points, p => heights[p.x]), 1);
  assert.equal(riverFlowSign([...points].reverse(), p => heights[p.x]), -1);
  assert.equal(riverFlowSign(points, () => 10), 1);
});

test('texture coordinates and tangents agree at mitered river bends', () => {
  const a = [{ x: -1, z: 0 }, { x: 1, z: 0 }];
  const b = [{ x: -1, z: 11 }, { x: 1, z: 9 }];
  const c = [{ x: 10, z: 11 }, { x: 10, z: 9 }];
  const normal = { x: 0, y: 1, z: 0 };
  for (const point of [b[0], b[1], { x: 0, z: 10 }]) {
    const first = riverSurfaceFrame(point, ...a, ...b, 0, 10, 2, normal, 1);
    const next = riverSurfaceFrame(point, ...b, ...c, 10, 10, 2, normal, 1);
    assert.deepEqual(first, next);
    assert.equal(first.v, 10);
    assert.ok(Math.abs(Math.hypot(...first.tangent.slice(0, 3)) - 1) < 1e-12);
  }
});

test('river tangent frames stay perpendicular to smooth sloping normals', () => {
  const normal = { x: 0.6, y: 0.8, z: 0 };
  const frame = riverSurfaceFrame({ x: 0, z: 5 },
    { x: -1, z: 0 }, { x: 1, z: 0 }, { x: -1, z: 10 }, { x: 1, z: 10 },
    0, 10, 2, normal, -1);
  assert.equal(frame.v, -5);
  assert.ok(Math.abs(frame.tangent[0] * normal.x + frame.tangent[1] * normal.y) < 1e-12);
});
