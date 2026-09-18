import { VertexBuffer, VertexData, type Mesh } from '@babylonjs/core';
import { PlanarCellIndex, convexPolygonsOverlap, pointBounds, type PlanarPoint } from '../core/PlanarGeometry';

interface RiverTriangle {
  outline: PlanarPoint[];
  elevation: number;
}

/** Roads must clear the actual water geometry, including narrow diagonal crossings. */
export async function raiseRoadsAboveRivers(
  roads: readonly Mesh[],
  rivers: readonly Pick<VertexData, 'positions' | 'indices'>[],
  metersPerUnit: number,
  yieldControl?: () => Promise<void>,
): Promise<void> {
  if (!rivers.length) return;
  const water = new PlanarCellIndex<RiverTriangle>(20 / metersPerUnit);
  for (const { positions, indices } of rivers) {
    if (!positions || !indices) continue;
    for (let i = 0; i < indices.length; i += 3) {
      const corners = [indices[i], indices[i + 1], indices[i + 2]];
      const outline = corners.map(v => ({ x: positions[v * 3], z: positions[v * 3 + 2] }));
      const elevation = Math.max(...corners.map(v => positions[v * 3 + 1]));
      water.add({ outline, elevation }, pointBounds(outline));
    }
  }
  // Also covers the river shader's millimetre-scale vertical motion.
  const clearance = 0.12 / metersPerUnit;
  const key = (x: number, z: number) => `${Math.round(x * 1e6)},${Math.round(z * 1e6)}`;
  for (const mesh of roads) {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    if (!positions || !indices) continue;
    const levels = new Map<string, number>();
    for (let i = 0; i < indices.length; i += 3) {
      const corners = [indices[i], indices[i + 1], indices[i + 2]];
      const outline = corners.map(v => ({ x: positions[v * 3], z: positions[v * 3 + 2] }));
      let minimum = -Infinity;
      for (const river of water.query(pointBounds(outline))) {
        if (convexPolygonsOverlap(outline, river.outline)) minimum = Math.max(minimum, river.elevation + clearance);
      }
      if (minimum !== -Infinity) {
        for (const point of outline) {
          const id = key(point.x, point.z);
          levels.set(id, Math.max(levels.get(id) ?? -Infinity, minimum));
        }
      }
      if (i % 384 === 0) await yieldControl?.();
    }
    const changed = new Set<number>();
    for (let i = 0; i < positions.length; i += 3) {
      const height = levels.get(key(positions[i], positions[i + 2]));
      if (height !== undefined && positions[i + 1] < height) {
        positions[i + 1] = height;
        changed.add(i / 3);
      }
    }
    if (!changed.size) continue;
    const computed: number[] = [];
    VertexData.ComputeNormals(positions, indices, computed);
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind) ?? computed;
    // Weld normals across duplicated UV/terrain triangle vertices at the crossing.
    const shared = new Map<string, number[]>();
    for (let v = 0; v < positions.length / 3; v++) {
      if (!changed.has(v)) continue;
      const id = key(positions[v * 3], positions[v * 3 + 2]);
      const sum = shared.get(id) ?? [0, 0, 0];
      for (let axis = 0; axis < 3; axis++) sum[axis] += computed[v * 3 + axis];
      shared.set(id, sum);
    }
    for (const v of changed) {
      const sum = shared.get(key(positions[v * 3], positions[v * 3 + 2]))!;
      const length = Math.hypot(...sum) || 1;
      for (let axis = 0; axis < 3; axis++) normals[v * 3 + axis] = sum[axis] / length;
    }
    mesh.setVerticesData(VertexBuffer.PositionKind, positions);
    mesh.setVerticesData(VertexBuffer.NormalKind, normals);
    mesh.refreshBoundingInfo();
    await yieldControl?.();
  }
}
