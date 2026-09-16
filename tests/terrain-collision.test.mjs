import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBuilder, NullEngine, Ray, Scene, UniversalCamera, Vector3 } from '@babylonjs/core';
import { enableTerrainCollisions } from '../src/terrain/TerrainCollision.ts';
import { moveWalkerWithCollisions } from '../src/app/WalkerCollision.ts';

test('terrain collision strips retain translated ground picks and walking without extra visible geometry', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const terrain = MeshBuilder.CreateGround('terrain', { width: 100, height: 100, subdivisions: 128 }, scene);
    terrain.position.set(100, 3, 200);
    terrain.checkCollisions = true;
    terrain.computeWorldMatrix(true);
    const ray = new Ray(new Vector3(105, 10, 205), Vector3.Down(), 20);
    const before = scene.pickWithRay(ray, m => m.checkCollisions && m.isEnabled());
    const collision = enableTerrainCollisions(terrain);
    collision.computeWorldMatrix(true);
    const after = scene.pickWithRay(ray, m => m.checkCollisions && m.isEnabled());
    assert.deepEqual(after.pickedPoint.asArray(), before.pickedPoint.asArray());
    assert.equal(collision.geometry, terrain.geometry);
    assert.equal(terrain.subMeshes.length, 1);
    assert.equal(collision.isVisible, false);
    assert.ok(collision.subMeshes.length > 1);
    const camera = new UniversalCamera('walker', new Vector3(105, 4.8, 205), scene);
    camera.ellipsoid.set(.3, .9, .3);
    moveWalkerWithCollisions(camera, 1, 0);
    assert.ok(camera.position.x > 105.9);
    terrain.setEnabled(false);
    assert.equal(scene.pickWithRay(ray, m => m.checkCollisions && m.isEnabled()).hit, false);
    terrain.dispose();
    assert.equal(collision.isDisposed(), true);
  } finally { scene.dispose(); engine.dispose(); }
});
