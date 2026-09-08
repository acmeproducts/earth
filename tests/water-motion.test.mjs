import assert from 'node:assert/strict';
import test from 'node:test';
import { maximumWaterLift, sampleWaterMotion, WATER_PROFILES } from '../src/WaterProfile.ts';

test('water rises at the crest and recedes below its mean level afterwards', () => {
  const profile = WATER_PROFILES.ocean;
  const crest = sampleWaterMotion(profile.periodSeconds / 4, 1, profile, 0);
  const trough = sampleWaterMotion(profile.periodSeconds * 3 / 4, 1, profile, 0);
  assert.ok(crest.height > 0.25);
  assert.equal(crest.crest, 1);
  assert.ok(trough.height < 0);
  assert.equal(trough.crest, 0);
  assert.ok(Math.abs(trough.height) <= profile.troughMeters);
});

test('a trough cannot drain a broad shallow shelf', () => {
  for (const profile of Object.values(WATER_PROFILES)) {
    let lowest = Infinity;
    for (let t = 0; t < profile.periodSeconds; t += 0.01) {
      lowest = Math.min(lowest, sampleWaterMotion(t, 1, profile).height);
    }
    assert.ok(lowest >= -profile.troughMeters - 1e-10);
    assert.ok(profile.troughMeters < profile.heaveMeters);
  }
});

test('shore waves meet the broad water without a vertical seam', () => {
  const profile = WATER_PROFILES.ocean;
  for (let t = 0; t < 10; t += 0.13) {
    assert.equal(sampleWaterMotion(t, 1, profile, -1.5).height, sampleWaterMotion(t, 1, profile).height);
  }
});

test('calm water is stationary and strong winds stay inside the padded bounds', () => {
  for (const profile of Object.values(WATER_PROFILES)) {
    for (let t = 0; t < 10; t += 0.1) {
      assert.equal(Math.abs(sampleWaterMotion(t, 0, profile, 0).height), 0);
      for (const bedHeight of [-1.5, -0.7, 0, 0.4]) {
        assert.ok(Math.abs(sampleWaterMotion(t, 3, profile, bedHeight).height) <= maximumWaterLift(profile));
      }
    }
  }
});
