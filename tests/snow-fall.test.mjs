import assert from "node:assert/strict";
import test from "node:test";
import { Mesh, MeshBuilder, NullEngine, Scene, VertexBuffer } from "@babylonjs/core";

const { simulateSnowfall, SNOW_UV_X } = await import("../src/rendering/SnowFall.ts");

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

test("snow lands on the top of a box and nowhere else", () => withScene((scene) => {
  const box = MeshBuilder.CreateBox("box", { size: 2 }, scene);
  const vertexCount = box.getTotalVertices();
  box.setVerticesData(VertexBuffer.ColorKind, new Float32Array(vertexCount * 4).fill(0.4));

  const result = simulateSnowfall(box, { cellSize: 0.5, depth: 0.3, amount: 1 });

  // Roughly one mound per half-metre cell over a 2 m top, allowing edge cells.
  assert.ok(result.mounds >= 12 && result.mounds <= 40, `mounds ${result.mounds}`);
  assert.equal(result.missed, 0);
  const positions = box.getVerticesData(VertexBuffer.PositionKind);
  const uvs = box.getVerticesData(VertexBuffer.UVKind);
  const colors = box.getVerticesData(VertexBuffer.ColorKind);
  for (let vertex = vertexCount; vertex < positions.length / 3; vertex++) {
    // Blanket vertices mark themselves through uv.x and are snow-white.
    assert.equal(uvs[vertex * 2], SNOW_UV_X);
    assert.ok(colors[vertex * 4 + 2] > 0.8);
    // Edge droop (0.7 of depth) plus jitter (0.15) bound the lowest corner.
    assert.ok(positions[vertex * 3 + 1] >= 1 - 0.3 * 0.85 - 1e-6, `y ${positions[vertex * 3 + 1]}`);
    assert.ok(positions[vertex * 3 + 1] <= 1 + 0.3 * 1.15 + 1e-6);
  }
}));

test("foliage clusters catch snow and let some through to a surface below", () => withScene((scene) => {
  const mesh = new Mesh("tree", scene);
  // A horizontal bark-like plate (uv.x >= 2) under a vertical foliage card (uv.x in [0, 1]).
  const positions = [
    -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1,
    -0.5, 2, 0, 0.5, 2, 0, 0.5, 3, 0, -0.5, 3, 0,
  ];
  const normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  const uvs = [2, 0, 3, 0, 3, 1, 2, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  mesh.setVerticesData(VertexBuffer.PositionKind, positions);
  mesh.setVerticesData(VertexBuffer.NormalKind, normals);
  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
  mesh.setIndices([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);

  const result = simulateSnowfall(mesh, {
    cellSize: 0.5, depth: 0.2, amount: 1, isFoliage: (uvX) => uvX < 1.5,
  });

  const out = mesh.getVerticesData(VertexBuffer.PositionKind);
  let high = 0;
  let low = 0;
  for (let vertex = 8; vertex < out.length / 3; vertex++) {
    if (out[vertex * 3 + 1] > 2.5) high++; else low++;
  }
  assert.ok(result.mounds > 0);
  assert.ok(high > 0, "the card's top catches a clump");
  assert.ok(low > 0, "the plate below still receives snow");
}));

test("a vertical wall alone catches nothing", () => withScene((scene) => {
  const wall = MeshBuilder.CreatePlane("wall", { size: 2 }, scene);
  const before = wall.getTotalIndices();
  const result = simulateSnowfall(wall, { cellSize: 0.5, depth: 0.2, amount: 1 });
  assert.equal(result.mounds, 0);
  assert.equal(wall.getTotalIndices(), before);
}));
