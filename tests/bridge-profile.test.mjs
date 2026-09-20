import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeProfile } from '../src/roads/BridgeProfile.ts';

test('a valley span meets both approaches and grades by physical distance', () => {
  const points = [0, 1, 10, 30, 40].map(x => ({ x, z: 0 }));
  assert.deepEqual(bridgeProfile(points, [20, 0, 0, 0, 30]), [20, 20.25, 22.5, 27.5, 30]);
});

test('interior clearance raises the span without lifting its land endpoints', () => {
  const points = [0, 10, 20, 30, 40].map(x => ({ x, z: 0 }));
  const levels = bridgeProfile(points, [5, 0, 12, 0, 6]);
  assert.deepEqual(levels, [5, 8.5, 12, 9, 6]);
  assert.deepEqual(bridgeProfile(points, levels), levels);
  assert.deepEqual(bridgeProfile([...points].reverse(), [6, 0, 12, 0, 5]), [...levels].reverse());
});

test('degenerate and curved spans remain finite', () => {
  assert.deepEqual(bridgeProfile([], []), []);
  assert.deepEqual(bridgeProfile([{ x: 0, z: 0 }], [3]), [3]);
  const points = [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 10 }, { x: 10, z: 10 }];
  assert.deepEqual(bridgeProfile(points, [2, 2, 0, 4]), [2, 2, 3, 4]);
});
