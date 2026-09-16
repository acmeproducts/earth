import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix, MeshBuilder, NullEngine, Scene, ShaderMaterial } from '@babylonjs/core';
import { prepareSceneForReveal, prepareInactiveInstanceShaders } from '../src/rendering/SceneReadiness.ts';

test('spawn readiness waits for submitted GPU work instead of revealing queued uploads', async () => {
  const calls = [];
  let releaseGpu;
  const engine = {
    beginFrame: () => calls.push('begin'), endFrame: () => calls.push('end'),
    readPixels: (...args) => { assert.deepEqual(args, [0, 0, 1, 1]); calls.push('fence'); return new Promise(resolve => { releaseGpu = resolve; }); },
  };
  const scene = { meshes: [], whenReadyAsync: async targets => { assert.equal(targets, true); calls.push('ready'); },
    getEngine: () => engine, render: () => calls.push('render') };
  let revealed = false;
  const pending = prepareSceneForReveal(scene).then(() => { revealed = true; });
  while (!releaseGpu) await Promise.resolve();
  assert.equal(revealed, false);
  assert.deepEqual(calls, ['ready', 'begin', 'render', 'end', 'ready', 'fence']);
  releaseGpu(new Uint8Array(4));
  await pending;
  assert.equal(revealed, true);
});

test('inactive vegetation compiles the thin-instance variant and restores draw counts on failure', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const mesh = MeshBuilder.CreateBox('inactive vegetation', {}, scene);
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(Matrix.Identity().asArray()), 16);
  mesh.thinInstanceCount = 0;
  mesh.setEnabled(false);
  mesh.material = new ShaderMaterial('vegetation', scene, { vertex: 'unused', fragment: 'unused' });
  let calls = 0;
  mesh.material.forceCompilationAsync = async (target, options) => {
    calls++;
    assert.equal(target, mesh);
    assert.equal(target.hasThinInstances, true);
    assert.equal(target.isEnabled(), false);
    assert.deepEqual(options, { useInstances: true });
    if (calls === 2) throw new Error('shader failed');
  };
  await prepareInactiveInstanceShaders(scene);
  assert.equal(calls, 1);
  assert.equal(mesh.hasThinInstances, false);
  assert.equal(mesh.thinInstanceCount, 0);
  await assert.rejects(prepareInactiveInstanceShaders(scene), /shader failed/);
  assert.equal(mesh.forcedInstanceCount, 0);
  assert.equal(mesh.thinInstanceCount, 0);
  scene.dispose(); engine.dispose();
});
