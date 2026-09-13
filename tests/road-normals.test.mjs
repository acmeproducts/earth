import test from "node:test";
import assert from "node:assert/strict";
import { MeshBuilder, NullEngine, Scene, VertexBuffer, VertexData } from "@babylonjs/core";
import { TerrainSurface } from "../src/TerrainSurface.ts";

test("road normals match ground vertices and remain continuous across triangle seams", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const mesh = MeshBuilder.CreateGround("ground", { width: 4, height: 4, subdivisions: 2, updatable: true }, scene);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const heights = new Float32Array(9);
    for (let i = 0; i < heights.length; i++) {
      const x = positions[i * 3];
      const z = positions[i * 3 + 2];
      heights[i] = positions[i * 3 + 1] = 0.3 * x * x + 0.2 * z * z;
    }
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, mesh.getIndices(), normals);
    mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
    mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
    const surface = TerrainSurface.fromGroundMesh(mesh, 4, 4);
    const fallback = new TerrainSurface(heights, 2, 4, 4);
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    for (let i = 0; i < heights.length; i++) {
      const point = { x: positions[i * 3], z: positions[i * 3 + 2] };
      const expected = { x: normals[i * 3], y: normals[i * 3 + 1], z: normals[i * 3 + 2] };
      assert.ok(distance(surface.normalAt(point), expected) < 1e-6);
      assert.ok(distance(fallback.normalAt(point), expected) < 1e-6);
      assert.ok(surface.normalAt(point).y > 0);
    }
    for (const point of [{ x: -1, z: 1 }, { x: 0, z: 1 }, { x: -1, z: 0 }]) {
      const a = surface.normalAt({ x: point.x - 1e-7, z: point.z - 1e-7 });
      const b = surface.normalAt({ x: point.x + 1e-7, z: point.z + 1e-7 });
      assert.ok(distance(a, b) < 1e-6, "normals must agree on either side of a fragment boundary");
      assert.ok(Math.abs(Math.hypot(a.x, a.y, a.z) - 1) < 1e-6);
    }
    assert.ok(distance(surface.normalAt({ x: -1.5, z: 1 }), surface.normalAt({ x: -0.5, z: 1 })) > 0.1,
      "lighting must vary smoothly within the ground triangle");
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
