import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { beachSurfaceColor } from "../src/terrain/BeachSurface.ts";

const grass = [0.58, 0.76, 0.36];

test("waterline and submerged shore have wet sand instead of green cover", () => {
  assert.deepEqual(beachSurfaceColor(grass, 0, 0), [0.38, 0.33, 0.25]);
  assert.deepEqual(beachSurfaceColor(grass, -10, -1), [0.38, 0.33, 0.25]);
});

test("beach dries above water and gives way to inland and steep-bank cover", () => {
  assert.deepEqual(beachSurfaceColor(grass, 5, 1.5), [0.76, 0.69, 0.53]);
  assert.deepEqual(beachSurfaceColor(grass, 24, 1), grass);
  assert.deepEqual(beachSurfaceColor(grass, 0, 6), grass);
  const transition = beachSurfaceColor(grass, 16, 1.5);
  assert.ok(transition[0] > grass[0] && transition[0] < 0.76);
});

test("rendered terrain applies beach tint after smoothing grass colors", async () => {
  // This integration path imports WorldCover's enum, which needs transformation
  // in addition to the test runner's normal TypeScript stripping.
  const hook = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith("/WorldCover.ts")) {
        return { format: "module", shortCircuit: true,
          source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }) };
      }
      return nextLoad(url, context);
    },
  });
  const { NullEngine, Scene, VertexBuffer } = await import("@babylonjs/core");
  const { createTerrainMesh } = await import("../src/terrain/TerrainMesh.ts");
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const ground = await createTerrainMesh(scene, "beach", {
      elevations: new Float32Array(9), width: 3, height: 3,
      minElevation: 0, maxElevation: 0,
      groundWidthMeters: 20, groundHeightMeters: 20,
      bounds: { lonWest: 10, lonEast: 10.001, latSouth: 59, latNorth: 59.001 },
      waterMask: new Uint8Array(9), shoreDistanceMeters: new Float32Array(9),
    }, {
      meshWidth: 20, meshDepth: 20, subdivisions: 2, metersPerUnit: 1,
      landCover: { sample: () => 30 },
    });
    const colors = ground.getVerticesData(VertexBuffer.ColorKind);
    for (let i = 0; i < 9; i++) {
      for (let channel = 0; channel < 3; channel++) {
        assert.ok(Math.abs(colors[i * 4 + channel] - [0.38, 0.33, 0.25][channel]) < 1e-6);
      }
    }
  } finally {
    scene.dispose();
    engine.dispose();
    hook.deregister();
  }
});
