import { Mesh, type Scene } from "@babylonjs/core";

interface GeometrySnapshot {
  indices: Uint32Array;
  buffers: Array<{ kind: string; size: number; data: Float32Array }>;
}

/** Keeps unscaled geometry and baked exposure, never tile-owned meshes/materials. */
export class TreeModelGeometryCache {
  private readonly entries = new Map<string, Promise<GeometrySnapshot[]>>();
  private readonly sizes = new Map<string, number>();
  private bytes = 0;

  private readonly maximumBytes: number;

  constructor(maximumBytes = 64 * 1024 * 1024) {
    this.maximumBytes = maximumBytes;
  }

  async create(key: string, scene: Scene, build: () => Promise<Mesh[]>): Promise<Mesh[]> {
    let request = this.entries.get(key);
    if (!request) {
      request = build().then((meshes) => {
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
      this.entries.set(key, request);
      request.then((snapshots) => {
        if (this.entries.get(key) !== request) return;
        const size = snapshots.reduce((sum, part) => sum + part.indices.byteLength +
          part.buffers.reduce((total, buffer) => total + buffer.data.byteLength, 0), 0);
        this.sizes.set(key, size);
        this.bytes += size;
        for (const oldest of this.entries.keys()) {
          if (this.bytes <= this.maximumBytes) break;
          const oldSize = this.sizes.get(oldest);
          if (oldSize === undefined) continue; // Do not evict builds in flight.
          this.entries.delete(oldest);
          this.sizes.delete(oldest);
          this.bytes -= oldSize;
        }
      }, () => {
        if (this.entries.get(key) === request) this.entries.delete(key);
      });
    } else {
      this.entries.delete(key);
      this.entries.set(key, request);
    }
    const snapshots = await request;
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
