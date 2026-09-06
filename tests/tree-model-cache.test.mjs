import assert from "node:assert/strict";
import test from "node:test";
import { Mesh, NullEngine, Scene, StandardMaterial, VertexBuffer } from "@babylonjs/core";
import { TreeModelGeometryCache } from "../src/TreeModelGeometryCache.ts";

test("tree geometry builds once for concurrent callers and survives tile mutation/disposal", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const cache = new TreeModelGeometryCache();
    let builds = 0;
    const build = async () => {
      builds++;
      const mesh = new Mesh("source", scene);
      mesh.material = new StandardMaterial("source material", scene);
      mesh.setVerticesData(VertexBuffer.PositionKind, [1, 2, 3]);
      mesh.setVerticesData("sunExposureLow", [0.1, 0.2, 0.3, 0.4], false, 4);
      mesh.setIndices([0]);
      return [mesh];
    };
    const [[first], [second]] = await Promise.all([
      cache.create("spruce/1/summer", scene, build),
      cache.create("spruce/1/summer", scene, build),
    ]);
    assert.equal(builds, 1);
    assert.notEqual(first.geometry, second.geometry);
    assert.equal(second.getVertexBuffer("sunExposureLow").getSize(), 4);
    const positions = first.getVerticesData(VertexBuffer.PositionKind);
    positions[0] = 999;
    first.setVerticesData(VertexBuffer.PositionKind, positions);
    first.dispose(false, true);
    const [third] = await cache.create("spruce/1/summer", scene, build);
    assert.equal(builds, 1);
    assert.deepEqual([...third.getVerticesData(VertexBuffer.PositionKind)], [1, 2, 3]);
    assert.deepEqual(third.getVerticesData("sunExposureLow"), second.getVerticesData("sunExposureLow"));
    await cache.create("spruce/2/summer", scene, build);
    await cache.create("spruce/1/winter", scene, build);
    assert.equal(builds, 3);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("failed tree builds can retry and over-budget entries are evicted", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const cache = new TreeModelGeometryCache(1);
    await assert.rejects(cache.create("tree", scene, async () => { throw new Error("bake failed"); }));
    let builds = 0;
    const build = async () => {
      builds++;
      const mesh = new Mesh("source", scene);
      mesh.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0]);
      mesh.setIndices([0]);
      return [mesh];
    };
    await cache.create("tree", scene, build);
    await cache.create("tree", scene, build);
    assert.equal(builds, 2);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
