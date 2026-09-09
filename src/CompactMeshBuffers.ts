import type { Mesh } from "@babylonjs/core";

/** Keeps merge inputs on Babylon's typed-array path instead of boxed arrays. */
export function compactMeshBuffers(mesh: Mesh): void {
  for (const kind of mesh.getVerticesDataKinds()) {
    const data = mesh.getVerticesData(kind);
    if (!Array.isArray(data)) continue;
    const buffer = mesh.getVertexBuffer(kind)!;
    mesh.setVerticesData(kind, Float32Array.from(data), buffer.isUpdatable(), buffer.getSize());
  }
  const indices = mesh.getIndices();
  if (Array.isArray(indices)) mesh.setIndices(Uint32Array.from(indices));
}
