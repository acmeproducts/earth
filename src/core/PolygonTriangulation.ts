import earcut from "earcut";
import type { PlanarPoint } from "./PlanarGeometry";

export interface Footprint {
  outline: readonly PlanarPoint[];
  holes: ReadonlyArray<readonly PlanarPoint[]>;
}

export function triangulate(polygon: Footprint): PlanarPoint[][] {
  const points = [...polygon.outline];
  const holes: number[] = [];
  for (const ring of polygon.holes) {
    if (ring.length < 3) continue;
    holes.push(points.length);
    points.push(...ring);
  }
  const indices = earcut(points.flatMap(({ x, z }) => [x, z]), holes);
  const result: PlanarPoint[][] = [];
  for (let i = 0; i < indices.length; i += 3) {
    result.push([points[indices[i]], points[indices[i + 1]], points[indices[i + 2]]]);
  }
  return result;
}
