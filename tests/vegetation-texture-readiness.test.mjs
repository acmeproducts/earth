import assert from "node:assert/strict";
import test from "node:test";
import { InternalTexture, InternalTextureSource, Mesh, NullEngine, Scene } from "@babylonjs/core";
import {
  createVertexColorCaptureMaterial,
  waitForVertexColorTextures,
} from "../src/procedural/ProceduralCaptureMaterial.ts";

for (const outcome of ["load", "error"]) {
  test(`leaf texture ${outcome} settles readiness with a usable sampler`, async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      let finish;
      engine.createTexture = (_url, _noMipmap, _invertY, _scene, _sampling, onLoad, onError) => {
        const texture = new InternalTexture(engine, InternalTextureSource.Url);
        finish = () => {
          texture.isReady = outcome === "load";
          if (outcome === "load") onLoad();
          else onError("simulated leaf image failure");
        };
        return texture;
      };
      const mesh = new Mesh("tree", scene);
      mesh.material = createVertexColorCaptureMaterial(scene, "tree", true, "leaf.png");
      const original = mesh.material.getActiveTextures().find((texture) => texture.url === "leaf.png");
      assert.ok(original);
      let settled = false;
      const ready = waitForVertexColorTextures([mesh]).then(() => { settled = true; });
      await Promise.resolve();
      assert.equal(settled, false, "models must wait while their leaf image is pending");
      finish();
      await ready;
      const textures = mesh.material.getActiveTextures();
      if (outcome === "error") {
        assert.ok(!textures.includes(original), "failed texture must be detached from the material");
        assert.ok(textures.some((texture) => texture.name === "fallbackWhiteTexture"));
      } else {
        assert.ok(textures.includes(original));
        assert.ok(original.isReady());
      }
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
}

test("an already-ready leaf texture does not wait for its deferred load callback", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    let deferredLoad;
    engine.createTexture = (_url, _noMipmap, _invertY, _scene, _sampling, onLoad) => {
      const texture = new InternalTexture(engine, InternalTextureSource.Url);
      texture.isReady = true;
      deferredLoad = onLoad;
      return texture;
    };
    const mesh = new Mesh("cached tree", scene);
    mesh.material = createVertexColorCaptureMaterial(scene, "cached tree", true, "cached-leaf.png");
    let settled = false;
    void waitForVertexColorTextures([mesh]).then(() => { settled = true; });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(settled, true, "a throttled load notification must not hold up tile construction");
    assert.equal(mesh.material._floats.leafTextureEnabled, 1);
    deferredLoad();
    assert.equal(mesh.material._floats.leafTextureEnabled, 1, "the eventual callback is harmless");
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
