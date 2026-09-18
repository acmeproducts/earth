import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix, Mesh, MeshBuilder, NullEngine, Scene, ShaderMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { createStaticImpostorField, createVegetationFieldResult } from '../src/vegetation/VegetationField.ts';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('distant trees cap capture memory while nearby trees retain configured quality and variant identity', async () => {
  const source = readFileSync(new URL('../src/vegetation/TreeImpostor.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('TreeImpostor.ts', source, ts.ScriptTarget.Latest, true);
  const fn = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'acquireTreeImpostorAssets');
  const code = ts.transpileModule(fn.getText(parsed).replace('export ', ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls = [];
  const acquire = new Function('measureFoliageTextures', 'treeImpostors',
    `${code}; return acquireTreeImpostorAssets;`)(async () => {}, {
    birch: { getDefaultSampling: () => ({ resolution: 192 }),
      acquireAssets: (...args) => { calls.push(args); return { release() {} }; } },
  });
  const variant = { key: 'same-forest', seed: 17 }, scene = {};
  await acquire(scene, 'birch', variant, true, false);
  await acquire(scene, 'birch', variant, true, true);
  assert.equal(calls[0][1], undefined, 'Nearby capture uses the configured quality');
  assert.equal(calls[1][1]?.resolution, 64, 'Distant captures must not allocate 192px frames');
  assert.equal(calls[1][2], variant, 'LOD must not change the forest identity');
});

test('render-only vegetation bounds do not retain a Vector3 object per model vertex', async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const root = new TransformNode('field', scene);
    const model = new Mesh('dense vegetation model', scene);
    model.parent = root;
    model.isPickable = false;
    const positions = new Float32Array(300_000);
    for (let i = 0; i < positions.length; i += 3) positions.set([-1, 2, 1], i);
    positions.set([1, 4, -1]);
    model.setVerticesData('position', Array.from(positions));
    model.setIndices([0, 1, 2]);
    const matrices = new Float32Array(32);
    Matrix.Translation(-10, 0, 0).copyToArray(matrices, 0);
    Matrix.Translation(20, 0, 0).copyToArray(matrices, 16);
    await createVegetationFieldResult(root, [], [model], matrices, 1, 'models');
    assert.ok(model.getVerticesData('position') instanceof Float32Array);
    assert.ok(model.getIndices() instanceof Uint32Array);
    assert.ok(model._internalAbstractMeshDataInfo._positions === null,
      'Bounding setup must not duplicate the packed vertices as persistent JS objects');
    const box = model.getBoundingInfo().boundingBox;
    assert.deepEqual(box.minimum.asArray(), [-11, 2, -1]);
    assert.deepEqual(box.maximum.asArray(), [21, 4, 1]);
    root.position.x = 30;
    root.computeWorldMatrix(true);
    model.unfreezeWorldMatrix();
    model.computeWorldMatrix(true);
    model.getBoundingInfo().update(model.getWorldMatrix());
    assert.ok(Vector3.Distance(box.minimumWorld, new Vector3(19, 2, -1)) < 1e-6);
  } finally { scene.dispose(); engine.dispose(); }
});

test('far forests share one matrix buffer and keep fades without model or LOD allocations', async () => {
  const engine = new NullEngine(), scene = new Scene(engine);
  try {
    const root = new TransformNode('far forest', scene);
    const mesh = MeshBuilder.CreateBox('impostor', {}, scene);
    mesh.parent = root;
    mesh.material = new ShaderMaterial('impostor', scene, 'unused', {});
    const matrices = new Float32Array(32);
    Matrix.Translation(1, 0, 0).copyToArray(matrices, 0);
    Matrix.Translation(10, 0, 0).copyToArray(matrices, 16);
    const field = await createStaticImpostorField(root, [mesh], matrices);
    assert.equal(mesh._thinInstanceDataStorage.matrixData, matrices);
    assert.equal(field.instanceMatrices, matrices);
    assert.equal(mesh.thinInstanceCount, 2);
    assert.equal(await field.prepareLod(Vector3.Zero(), 100), false);
    assert.equal(field.updateLod(new Vector3(100, 0, 0), 100), false);
    assert.equal(field.consumeLodDebugStats().processedInstances, 0);
    assert.equal(field.modelMeshes.length, 0);
    assert.equal(field.shadowCasterMeshes.length, 0);
    field.setFade(0.4);
    assert.equal(mesh.material._floats.fieldFade, 0.4);
    assert.equal(mesh._thinInstanceDataStorage.matrixData, matrices);
  } finally { scene.dispose(); engine.dispose(); }
});
