import assert from "node:assert/strict";
import test from "node:test";
import {
  MeshBuilder,
  NullEngine,
  Scene,
  UniversalCamera,
  Vector3,
} from "@babylonjs/core";

import {
  advanceWalkerVerticalMotion,
  FLY_CAMERA_INERTIA,
  WALK_CAMERA_INERTIA,
  WALKER_JUMP_SPEED_METERS_PER_SECOND,
} from "../src/app/WalkerMotion.ts";
import { moveWalkerWithCollisions } from "../src/app/WalkerCollision.ts";

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

test("camera input is immediate in both movement modes", () => {
  assert.equal(WALK_CAMERA_INERTIA, 0);
  assert.equal(FLY_CAMERA_INERTIA, 0);
});

test("walker movement stops at a collidable house wall", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.collisionsEnabled = true;
  const wall = MeshBuilder.CreateBox("house wall", {
    width: 8,
    height: 3,
    depth: 0.2,
  }, scene);
  wall.position.set(0, 1.5, 2);
  wall.checkCollisions = true;
  wall.computeWorldMatrix(true);

  const camera = new UniversalCamera("walker", new Vector3(0, 1.8, 0), scene);
  camera.checkCollisions = true;
  camera.ellipsoid.set(0.3, 0.9, 0.3);
  camera.ellipsoidOffset.setAll(0);

  moveWalkerWithCollisions(camera, 0, 4);

  assert.ok(camera.position.z < 1.7, `walker crossed the wall at z=${camera.position.z}`);
  assert.equal(camera.position.x, 0);
  scene.dispose();
  engine.dispose();
});
