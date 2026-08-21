import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptiveCameraNearClipMeters,
  MAX_CAMERA_NEAR_CLIP_METERS,
  MIN_CAMERA_NEAR_CLIP_METERS,
} from "../src/CameraDepth.ts";

test("keeps a close near plane while walking at eye height", () => {
  assert.equal(adaptiveCameraNearClipMeters(1.8), MIN_CAMERA_NEAR_CLIP_METERS);
});

test("raises the near plane for distant views", () => {
  assert.equal(adaptiveCameraNearClipMeters(100), 5);
  assert.equal(adaptiveCameraNearClipMeters(1_000), MAX_CAMERA_NEAR_CLIP_METERS);
});

test("handles invalid and below-ground clearances conservatively", () => {
  assert.equal(adaptiveCameraNearClipMeters(Number.NaN), MIN_CAMERA_NEAR_CLIP_METERS);
  assert.equal(adaptiveCameraNearClipMeters(-10), MIN_CAMERA_NEAR_CLIP_METERS);
});
