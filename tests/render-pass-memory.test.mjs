import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBuilder, NullEngine, Scene } from '@babylonjs/core';
import { guardUnusedRenderPassCleanup } from '../src/rendering/RenderPassCleanup.ts';

test('releasing thousands of capture passes does not grow unrelated mesh caches', () => {
  guardUnusedRenderPassCleanup();
  guardUnusedRenderPassCleanup();
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const mesh = MeshBuilder.CreateBox('resident terrain', {}, scene);
    const subMesh = mesh.subMeshes[0];
    const initialLength = subMesh._drawWrappers.length;
    for (let i = 0; i < 3000; i++) {
      const pass = engine.createRenderPassId('temporary atlas capture');
      engine.releaseRenderPassId(pass);
    }
    assert.equal(subMesh._drawWrappers.length, initialLength);
    const usedPass = engine.createRenderPassId('used pass');
    const wrapper = subMesh._getDrawWrapper(usedPass, true);
    let disposed = 0;
    const dispose = wrapper.dispose.bind(wrapper);
    wrapper.dispose = (...args) => { disposed++; dispose(...args); };
    engine.releaseRenderPassId(usedPass);
    assert.equal(disposed, 1, 'Actual pass owners must still release their GPU resources');
    assert.equal(subMesh._getDrawWrapper(usedPass), undefined);
    engine.releaseRenderPassId(usedPass);
    assert.equal(disposed, 1);
  } finally { scene.dispose(); engine.dispose(); }
});
