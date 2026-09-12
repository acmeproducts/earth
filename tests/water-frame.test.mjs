import assert from 'node:assert/strict';
import test from 'node:test';
import { waterFrame, waterMotionSpeed } from '../src/WaterFrame.ts';
import { setManualWindSpeed } from '../src/Wind.ts';

function clock(t, start) {
  let now = start;
  let id = 0;
  const scene = { getFrameId: () => id };
  t.mock.method(performance, 'now', () => now);
  t.after(() => setManualWindSpeed(undefined));
  return {
    scene,
    advance(milliseconds) { now += milliseconds; id++; return waterFrame(scene); },
  };
}

test('wind changes after hours of runtime only move water by one frame of velocity', t => {
  const timer = clock(t, 6 * 60 * 60 * 1000);
  setManualWindSpeed(20);
  let previous = waterFrame(timer.scene);
  for (const speed of [30, 5, 20, 0, 30]) {
    setManualWindSpeed(speed);
    const next = timer.advance(16);
    const distance = Math.hypot(next.driftX - previous.driftX, next.driftY - previous.driftY);
    assert.ok(Math.abs(distance - 0.016 * waterMotionSpeed(speed / 20)) < 1e-10);
    previous = next;
  }
});

test('all water consumers share drift without advancing it again in the same frame', t => {
  const timer = clock(t, 1000);
  setManualWindSpeed(20);
  waterFrame(timer.scene);
  const first = timer.advance(16);
  assert.ok(Math.hypot(first.driftX, first.driftY) > 0);
  for (let material = 0; material < 20; material++) {
    assert.strictEqual(waterFrame(timer.scene), first);
  }
  const next = timer.advance(16);
  assert.strictEqual(waterFrame(timer.scene), next);
});

test('resuming after a long pause limits water movement to a tenth of a second', t => {
  const timer = clock(t, 1000);
  setManualWindSpeed(20);
  const before = waterFrame(timer.scene);
  const after = timer.advance(60_000);
  assert.ok(Math.abs(Math.hypot(after.driftX - before.driftX, after.driftY - before.driftY)
    - 0.1 * waterMotionSpeed(1)) < 1e-10);
});
