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

/** Appends generated geometry while keeping all original vertex channels. */
export function appendMeshBuffers(
  mesh: Mesh,
  kinds: readonly { kind: string; size: number; data: ArrayLike<number>; extra: number[] }[],
  indices: ArrayLike<number>,
  newIndices: number[],
  vertexCount: number,
): void {
  for (const entry of kinds) {
    const merged = new Float32Array(entry.data.length + entry.extra.length);
    merged.set(entry.data);
    merged.set(entry.extra, entry.data.length);
    mesh.setVerticesData(entry.kind, merged, false, entry.size);
  }
  const mergedIndices = new Uint32Array(indices.length + newIndices.length);
  mergedIndices.set(indices);
  mergedIndices.set(newIndices, indices.length);
  mesh.setIndices(mergedIndices, vertexCount);
  mesh.refreshBoundingInfo();
}
