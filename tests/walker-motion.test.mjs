import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceWalkerVerticalMotion,
  FLY_CAMERA_INERTIA,
  WALK_CAMERA_INERTIA,
  WALKER_JUMP_SPEED_METERS_PER_SECOND,
} from "../src/WalkerMotion.ts";

test("a grounded walker follows ordinary downhill terrain without falling", () => {
  const result = advanceWalkerVerticalMotion({
    eyeHeight: 10,
    verticalVelocityMetersPerSecond: 0,
    groundEyeHeightBeforeMove: 10,
    groundEyeHeightAfterMove: 9.8,
    metersPerUnit: 1,
    deltaSeconds: 1 / 60,
  });

  assert.deepEqual(result, {
    eyeHeight: 9.8,
    verticalVelocityMetersPerSecond: 0,
  });
});

test("a grounded walker still falls from a large ledge", () => {
  const result = advanceWalkerVerticalMotion({
    eyeHeight: 10,
    verticalVelocityMetersPerSecond: 0,
    groundEyeHeightBeforeMove: 10,
    groundEyeHeightAfterMove: 8,
    metersPerUnit: 1,
    deltaSeconds: 0.05,
  });

  assert.ok(result.eyeHeight < 10);
  assert.ok(result.eyeHeight > 8);
  assert.ok(result.verticalVelocityMetersPerSecond < 0);
});

test("a grounded walker can jump", () => {
  const result = advanceWalkerVerticalMotion({
    eyeHeight: 10,
    verticalVelocityMetersPerSecond: 0,
    groundEyeHeightBeforeMove: 10,
    groundEyeHeightAfterMove: 10,
    metersPerUnit: 1,
    deltaSeconds: 1 / 60,
    jumpRequested: true,
  });

  assert.ok(result.eyeHeight > 10);
  assert.ok(result.verticalVelocityMetersPerSecond > 0);
  assert.ok(result.verticalVelocityMetersPerSecond < WALKER_JUMP_SPEED_METERS_PER_SECOND);
});

test("an airborne walker cannot jump again", () => {
  const result = advanceWalkerVerticalMotion({
    eyeHeight: 11,
    verticalVelocityMetersPerSecond: 1,
    groundEyeHeightBeforeMove: 10,
    groundEyeHeightAfterMove: 10,
    metersPerUnit: 1,
    deltaSeconds: 0.05,
    jumpRequested: true,
  });

  assert.ok(result.verticalVelocityMetersPerSecond < 1);
  assert.ok(result.verticalVelocityMetersPerSecond > 0);
});

test("only fly mode uses camera inertia", () => {
  assert.equal(WALK_CAMERA_INERTIA, 0);
  assert.ok(FLY_CAMERA_INERTIA > 0);
});
