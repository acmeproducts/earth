import { Mesh, MultiMaterial, VertexBuffer } from "@babylonjs/core";
import type { Observer, Node, Scene } from "@babylonjs/core";
import { meshSnowCover, setMeshSnowCover } from "./SnowCover";
import { registerStaticMeshCandidates } from "./StaticMeshCandidates";
import { compactMeshBuffers } from "./CompactMeshBuffers";

interface BatchGroup {
  sources: Map<Mesh, Observer<Node>>;
  batch?: Mesh;
  ready: boolean;
  snow: number;
  metersPerUnit: number;
}

/** Render-only batches: source geometry remains resident for terrain queries and collisions. */
export class StaticMeshBatches {
  private readonly groups = new Map<string, BatchGroup>();
  private readonly pending = new Set<BatchGroup>();

  private readonly scene: Scene;

  constructor(scene: Scene) { this.scene = scene; }

  add(mesh: Mesh, region: string, metersPerUnit: number): void {
    if (!mesh.material || mesh.material instanceof MultiMaterial || mesh.hasThinInstances) return;
    // Sources stay resident for collision queries; keep both them and the
    // merged output on Babylon's packed-array path across the whole horizon.
    compactMeshBuffers(mesh);
    const key = `${region}/${mesh.material.uniqueId}/${mesh.receiveShadows}/${mesh.getVerticesDataKinds().sort().join(",")}`;
    let group = this.groups.get(key);
    if (!group) {
      group = { sources: new Map(), ready: false, snow: 0, metersPerUnit };
      this.groups.set(key, group);
    }
    if (group.sources.has(mesh)) return;
    this.restore(group);
    const owner = group;
    const observer = mesh.onDisposeObservable.addOnce(() => {
      owner.sources.delete(mesh);
      this.restore(owner);
      if (owner.sources.size === 0) {
        this.groups.delete(key);
        this.pending.delete(owner);
      } else this.pending.add(owner);
    });
    group.sources.set(mesh, observer);
    this.pending.add(group);
  }

  update(validate = true): void {
    if (!validate && this.pending.size === 0) return;
    for (const group of this.groups.values()) {
      let snow: number | undefined;
      let ready = group.sources.size > 1;
      for (const mesh of group.sources.keys()) {
        snow ??= meshSnowCover(mesh);
        if (!mesh.isEnabled() || mesh.visibility !== 1 || meshSnowCover(mesh) !== snow) {
          ready = false;
          break;
        }
      }
      if (ready !== group.ready || snow !== group.snow) {
        this.restore(group);
        group.ready = ready;
        group.snow = snow ?? 0;
        if (ready) this.pending.add(group);
      }
    }
    // Bound geometry uploads to one small geographic group per frame.
    for (const group of this.pending) {
      this.pending.delete(group);
      if (!group.ready || group.sources.size < 2) continue;
      const sources = [...group.sources.keys()];
      const batch = Mesh.MergeMeshes(sources, false, true);
      if (!batch) continue;
      // Babylon merges standard vertex data but drops shader-specific attributes.
      for (const kind of sources[0].getVerticesDataKinds()) {
        if ([VertexBuffer.PositionKind, VertexBuffer.NormalKind, VertexBuffer.TangentKind].includes(kind)) continue;
        const values = sources.map(mesh => mesh.getVerticesData(kind)!);
        const joined = new Float32Array(values.reduce((length, value) => length + value.length, 0));
        let offset = 0;
        for (const value of values) { joined.set(value, offset); offset += value.length; }
        batch.setVerticesData(kind, joined, false, sources[0].getVertexBuffer(kind)!.getSize());
      }
      batch.name = "far static batch";
      batch.material = sources[0].material;
      batch.receiveShadows = sources[0].receiveShadows;
      batch.isPickable = false;
      batch.checkCollisions = false;
      setMeshSnowCover(batch, group.snow, group.metersPerUnit);
      registerStaticMeshCandidates(this.scene, [batch]);
      for (const source of sources) source.isVisible = false;
      group.batch = batch;
      break;
    }
  }

  private restore(group: BatchGroup): void {
    if (!group.batch) return;
    group.batch.dispose(false, false);
    group.batch = undefined;
    for (const mesh of group.sources.keys()) if (!mesh.isDisposed()) mesh.isVisible = true;
  }

  dispose(): void {
    for (const group of this.groups.values()) {
      this.restore(group);
      for (const [mesh, observer] of group.sources) mesh.onDisposeObservable.remove(observer);
    }
    this.groups.clear();
    this.pending.clear();
  }
}
