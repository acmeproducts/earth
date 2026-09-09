import earcut from 'earcut';
import { cross, PlanarCellIndex, pointBounds, signedArea, type PlanarPoint } from './PlanarGeometry';
import type { ShorelineGeometry } from './ShorelineGeometry';

export interface WaterBoundary {
  outline: readonly PlanarPoint[];
  holes: ReadonlyArray<readonly PlanarPoint[]>;
}

/** Clip wave geometry to mapped water, carrying the sampled bed depth through every cut. */
export function clipShorelineToWater(geometry: ShorelineGeometry, boundary: WaterBoundary): ShorelineGeometry {
  const points = [...boundary.outline];
  const holes: number[] = [];
  for (const ring of boundary.holes) {
    if (ring.length < 3) continue;
    holes.push(points.length);
    points.push(...ring);
  }
  const indices = earcut(points.flatMap(p => [p.x, p.z]), holes);
  const bounds = pointBounds(points);
  const index = new PlanarCellIndex<PlanarPoint[]>(Math.max(1e-6,
    Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 8));
  for (let i = 0; i < indices.length; i += 3) {
    const triangle = indices.slice(i, i + 3).map(i => points[i]);
    if (signedArea(triangle) < 0) triangle.reverse();
    index.add(triangle, pointBounds(triangle));
  }
  const result: ShorelineGeometry = { positions: [], indices: [], depths: [] };
  for (let i = 0; i < geometry.indices.length; i += 3) {
    const triangle = geometry.indices.slice(i, i + 3).map(i => ({
      x: geometry.positions[i * 3], y: geometry.positions[i * 3 + 1],
      z: geometry.positions[i * 3 + 2], depth: geometry.depths[i],
    }));
    for (const cutter of index.query(pointBounds(triangle))) {
      let polygon = triangle;
      for (let edge = 0; edge < 3 && polygon.length; edge++) {
        const a = cutter[edge], b = cutter[(edge + 1) % 3];
        const clipped: typeof polygon = [];
        for (let j = 0; j < polygon.length; j++) {
          const p = polygon[j], q = polygon[(j + 1) % polygon.length];
          const dp = cross(a, b, p), dq = cross(a, b, q);
          if (dp >= 0) clipped.push(p);
          if ((dp >= 0) !== (dq >= 0)) {
            const t = dp / (dp - dq);
            clipped.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t,
              z: p.z + (q.z - p.z) * t, depth: p.depth + (q.depth - p.depth) * t });
          }
        }
        polygon = clipped;
      }
      if (polygon.length < 3 || Math.abs(signedArea(polygon)) < 1e-14) continue;
      const start = result.depths.length;
      for (const p of polygon) {
        result.positions.push(p.x, p.y, p.z);
        result.depths.push(p.depth);
      }
      for (let j = 1; j < polygon.length - 1; j++) result.indices.push(start, start + j, start + j + 1);
    }
  }
  return result;
}
