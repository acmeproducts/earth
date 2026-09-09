import assert from 'node:assert/strict';
import test from 'node:test';
import { Mesh, NullEngine, Scene, VertexBuffer, Ray, Vector3 } from '@babylonjs/core';
import { compactMeshBuffers } from '../src/CompactMeshBuffers.ts';

test('compact merge buffers preserve attributes, transforms, bounds and picking', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const create = (x) => {
      const mesh = new Mesh('triangle', scene);
      mesh.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0, 0, 1, 0, 1, 0, 0]);
      mesh.setVerticesData(VertexBuffer.NormalKind, [0, 0, -1, 0, 0, -1, 0, 0, -1]);
      mesh.setVerticesData(VertexBuffer.ColorKind, Array(12).fill(0.5));
      mesh.setIndices([0, 1, 2]);
      mesh.position.x = x;
      compactMeshBuffers(mesh);
      assert.ok(mesh.getVerticesData(VertexBuffer.PositionKind) instanceof Float32Array);
      assert.ok(mesh.getIndices() instanceof Uint32Array);
      return mesh;
    };
    const merged = Mesh.MergeMeshes([create(0), create(2)], true, true);
    assert.ok(merged.getVerticesData(VertexBuffer.PositionKind) instanceof Float32Array);
    assert.equal(merged.getTotalVertices(), 6);
    assert.deepEqual([...merged.getVerticesData(VertexBuffer.PositionKind)],
      [0,0,0, 0,1,0, 1,0,0, 2,0,0, 2,1,0, 3,0,0]);
    assert.deepEqual([...merged.getVerticesData(VertexBuffer.ColorKind)], Array(24).fill(0.5));
    merged.computeWorldMatrix(true);
    assert.equal(merged.intersects(new Ray(new Vector3(2.25,0.25,-1), new Vector3(0,0,1))).hit, true);
    assert.equal(merged.getBoundingInfo().boundingBox.maximum.x, 3);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
