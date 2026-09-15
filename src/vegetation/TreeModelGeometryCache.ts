import { Mesh, type Scene } from "@babylonjs/core";
import { ResourceCache } from "../core/ResourceCache";

interface GeometrySnapshot {
  indices: Uint32Array;
  buffers: Array<{ kind: string; size: number; data: Float32Array }>;
}

/** Keeps unscaled geometry and baked exposure, never tile-owned meshes/materials. */
export class TreeModelGeometryCache {
  private readonly snapshots: ResourceCache<GeometrySnapshot[]>;

  constructor(maximumBytes = 64 * 1024 * 1024) {
    this.snapshots = new ResourceCache(
      maximumBytes,
      (snapshots) => snapshots.reduce((sum, part) => sum + part.indices.byteLength +
        part.buffers.reduce((total, buffer) => total + buffer.data.byteLength, 0), 0),
      // Preserve the tree cache's byte-only limit.
      Infinity,
    );
  }

  async create(key: string, scene: Scene, build: () => Promise<Mesh[]>): Promise<Mesh[]> {
    const snapshots = await this.snapshots.getOrCreate(key, async () => {
      const meshes = await build();
      try {
        return meshes.map((mesh) => ({
          indices: Uint32Array.from(mesh.getIndices()!),
          buffers: mesh.getVerticesDataKinds().map((kind) => ({
            kind,
            size: mesh.getVertexBuffer(kind)!.getSize(),
            data: Float32Array.from(mesh.getVerticesData(kind)!),
          })),
        }));
      } finally {
        const materials = new Set(meshes.map((mesh) => mesh.material));
        meshes.forEach((mesh) => mesh.dispose(false, false));
        materials.forEach((material) => material?.dispose(true, false));
      }
    });
    if (scene.isDisposed) throw new Error("Tree model scene disposed during generation.");
    return snapshots.map((part, index) => {
      const mesh = new Mesh(`cachedTreePart${index}`, scene);
      mesh.isPickable = false;
      mesh.useVertexColors = true;
      for (const buffer of part.buffers) {
        // Scaling and per-tile buffers must never mutate the cached source.
        mesh.setVerticesData(buffer.kind, buffer.data.slice(), false, buffer.size);
      }
      mesh.setIndices(part.indices.slice());
      return mesh;
    });
  }
}
