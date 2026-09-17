import assert from "node:assert/strict";
import test from "node:test";
import { MeshBuilder, NullEngine, Scene, VertexBuffer } from "@babylonjs/core";

const { appendSnowShell } = await import("../src/rendering/SnowShell.ts");

function withScene(run) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    return run(scene);
  } finally {
    scene.dispose();
    engine.dispose();
  }
}

test("slabs extrude only the upward faces and close them with side walls", () => withScene((scene) => {
  const box = MeshBuilder.CreateBox("box", { size: 2 }, scene);
  const vertexCount = box.getTotalVertices();
  const indexCount = box.getTotalIndices();
  box.setVerticesData(VertexBuffer.ColorKind, new Float32Array(vertexCount * 4).fill(0.5));

  const capFaces = appendSnowShell(box, { thickness: 0.3 });

  // The top of a box is two triangles; its four boundary edges each add a quad.
  assert.equal(capFaces, 2);
  assert.equal(box.getTotalIndices(), indexCount + 2 * 3 + 4 * 6);
  const positions = box.getVerticesData(VertexBuffer.PositionKind);
  const colors = box.getVerticesData(VertexBuffer.ColorKind);
  let highest = -Infinity;
  for (let vertex = vertexCount; vertex < positions.length / 3; vertex++) {
    highest = Math.max(highest, positions[vertex * 3 + 1]);
    // Slab vertices are snow-white regardless of the base color.
    assert.ok(colors[vertex * 4] > 0.8 && colors[vertex * 4 + 2] > colors[vertex * 4]);
  }
  assert.ok(highest > 1.2 && highest <= 1 + 0.3 * 1.25 + 1e-6, `slab top ${highest}`);
}));

test("building roofs use the surface filter and write the snow surface id", () => withScene((scene) => {
  const box = MeshBuilder.CreateBox("building", { size: 2 }, scene);
  const vertexCount = box.getTotalVertices();
  const positions = box.getVerticesData(VertexBuffer.PositionKind);
  // Mark the top face as roof tile (6), everything else plaster (0).
  const surfaces = new Float32Array(vertexCount * 2);
  for (let vertex = 0; vertex < vertexCount; vertex++) surfaces[vertex * 2] = positions[vertex * 3 + 1] > 0.9 ? 6 : 0;
  box.setVerticesData(VertexBuffer.UV2Kind, surfaces);

  const capFaces = appendSnowShell(box, {
    thickness: 0.25,
    capFilter: (vertex) => surfaces[vertex * 2] === 6,
    surfaceId: 10,
  });

  assert.equal(capFaces, 2);
  const outSurfaces = box.getVerticesData(VertexBuffer.UV2Kind);
  assert.ok(outSurfaces.slice(vertexCount * 2).filter((_, index) => index % 2 === 0).every((id) => id === 10));
}));

test("a mesh with nothing to cover is left untouched", () => withScene((scene) => {
  const plane = MeshBuilder.CreatePlane("wall", { size: 1 }, scene);
  const before = plane.getTotalIndices();
  assert.equal(appendSnowShell(plane, { thickness: 0.2 }), 0);
  assert.equal(plane.getTotalIndices(), before);
}));
