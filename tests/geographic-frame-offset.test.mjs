import assert from "node:assert/strict";
import test from "node:test";
import {
  geographicFrameOffset,
  lonLatToScene,
} from "../src/world/Geo.ts";

test("places shifted terrain windows in one stable scene frame", () => {
  const frame = {
    bounds: { lonWest: 10, lonEast: 12, latNorth: 61, latSouth: 59 },
    meshWidth: 200,
    meshDepth: 200,
  };
  const target = {
    bounds: { lonWest: 11, lonEast: 13, latNorth: 61, latSouth: 59 },
    meshWidth: 200,
    meshDepth: 200,
  };
  const offset = geographicFrameOffset(frame, target);
  const longitude = 11.7;
  const latitude = 60.2;
  const stable = lonLatToScene(
    longitude,
    latitude,
    frame.bounds,
    frame.meshWidth,
    frame.meshDepth,
  );
  const local = lonLatToScene(
    longitude,
    latitude,
    target.bounds,
    target.meshWidth,
    target.meshDepth,
  );

  assert.ok(Math.abs(stable.x - (local.x + offset.x)) < 1e-9);
  assert.ok(Math.abs(stable.z - (local.z + offset.z)) < 1e-9);
});
