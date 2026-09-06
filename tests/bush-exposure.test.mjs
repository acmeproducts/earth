import assert from "node:assert/strict";
import test from "node:test";
import { NullEngine, Scene, VertexBuffer } from "@babylonjs/core";
import { createBushModel } from "../src/BushImpostor.ts";

test("bush foliage has directional occlusion that survives cached model scaling", async (t) => {
  const originalFrame = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  t.after(() => {
    if (originalFrame) globalThis.requestAnimationFrame = originalFrame;
    else delete globalThis.requestAnimationFrame;
    if (originalCancel) globalThis.cancelAnimationFrame = originalCancel;
    else delete globalThis.cancelAnimationFrame;
  });
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const first = await createBushModel(scene, 2.2, 123);
    const second = await createBushModel(scene, 4.4, 123);
    assert.ok(first.material.options.defines.includes("#define TREE_EXPOSURE"));
    const uvs = first.getVerticesData(VertexBuffer.UVKind);
    assert.equal(uvs.length, first.getTotalVertices() * 2);
    for (const kind of ["sunExposureLow", "sunExposureHigh"]) {
      const values = first.getVerticesData(kind);
      assert.equal(values.length, first.getTotalVertices() * 4);
      assert.ok(values.some((value) => value < 0.5), "interior foliage is shaded");
      assert.ok(values.some((value) => value > 0.9), "outer foliage is exposed");
      assert.ok(values.some((value, i) => i % 4 !== 0 && Math.abs(value - values[i - i % 4]) > 0.1), "sun direction changes exposure");
      assert.deepEqual(values, second.getVerticesData(kind));
    }
    const small = first.getVerticesData(VertexBuffer.PositionKind);
    const large = second.getVerticesData(VertexBuffer.PositionKind);
    for (let i = 0; i < small.length; i++) assert.ok(Math.abs(large[i] - small[i] * 2) < 0.00001);
    assert.notEqual(first.material, second.material);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
