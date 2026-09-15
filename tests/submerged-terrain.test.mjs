import test from "node:test";
import assert from "node:assert/strict";
import {
  SUBMERGED_TERRAIN_CEILING_METERS,
  sinkSubmergedElevation,
  sinkSubmergedTerrain,
} from "../src/world/Geo.ts";

test("sinks every zero and negative terrain sample below the water", () => {
  const terrain = {
    elevations: new Float32Array([12, 0.25, 0, -0.1, -5]),
    minElevation: -5,
    maxElevation: 12,
  };

  sinkSubmergedTerrain(terrain);

  assert.deepEqual(
    Array.from(terrain.elevations),
    [
      12,
      0.25,
      SUBMERGED_TERRAIN_CEILING_METERS,
      SUBMERGED_TERRAIN_CEILING_METERS,
      SUBMERGED_TERRAIN_CEILING_METERS,
    ],
  );
  assert.equal(terrain.minElevation, SUBMERGED_TERRAIN_CEILING_METERS);
  assert.equal(terrain.maxElevation, 12);
});

test("sinks shallow elevations recreated by terrain interpolation", () => {
  assert.equal(sinkSubmergedElevation(-0.001), SUBMERGED_TERRAIN_CEILING_METERS);
  assert.equal(sinkSubmergedElevation(0), SUBMERGED_TERRAIN_CEILING_METERS);
  assert.equal(sinkSubmergedElevation(0.001), 0.001);
  assert.equal(sinkSubmergedElevation(-75), -75);
});
