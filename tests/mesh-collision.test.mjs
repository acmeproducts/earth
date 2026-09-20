import assert from 'node:assert/strict';
import test from 'node:test';
import { Mesh, MeshBuilder, NullEngine, Ray, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { enableBatchedMeshCollisions } from '../src/rendering/MeshCollision.ts';

test('collision batches preserve closest translated floor and wall picks without render batches', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const parts = Array.from({length: 200}, (_, i) => {
      const box = MeshBuilder.CreateBox('floor', {width: 8, height: .2, depth: 8}, scene);
      box.position.set((i % 20) * 10, Math.floor(i / 20) * 3, 0);
      return box;
    });
    const mesh = Mesh.MergeMeshes(parts, true, true);
    const root = new TransformNode('tile', scene);
    root.position.set(100, 4, 200);
    mesh.parent = root;
    mesh.checkCollisions = true;
    const rays = [];
    for (let i = 0; i < 20; i++) {
      rays.push(new Ray(new Vector3(100 + i * 10, 40, 200), Vector3.Down(), 50));
      rays.push(new Ray(new Vector3(100 + i * 10, 7, 190), Vector3.Forward(), 30));
    }
    rays.push(new Ray(new Vector3(95, 40, 200), Vector3.Down(), 50));
    const pick = ray => scene.pickWithRay(ray, m => m.checkCollisions && m.isEnabled());
    const before = rays.map(ray => pick(ray).pickedPoint?.asArray());
    const renderSubmeshes = mesh.subMeshes.length;
    const collision = enableBatchedMeshCollisions(mesh);
    assert.equal(collision.geometry, mesh.geometry);
    assert.equal(mesh.subMeshes.length, renderSubmeshes);
    assert.equal(collision.isVisible, false);
    assert.equal(collision.isPickable, false);
    assert.equal(mesh.checkCollisions, false);
    assert.ok(collision.subMeshes.length > 1);
    assert.deepEqual(rays.map(ray => pick(ray).pickedPoint?.asArray()), before);
    root.setEnabled(false);
    assert.equal(pick(rays[0]).hit, false);
    root.setEnabled(true);
    assert.equal(pick(rays[0]).hit, true);
    root.dispose();
    assert.equal(collision.isDisposed(), true);
  } finally { scene.dispose(); engine.dispose(); }
});
