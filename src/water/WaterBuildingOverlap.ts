import earcut from "earcut";
import {
  boundsOverlap, PlanarCellIndex, pointBounds, polygonArea, subtractConvex,
  type PlanarPoint,
} from "../core/PlanarGeometry";

export interface Footprint {
  outline: readonly PlanarPoint[];
  holes: ReadonlyArray<readonly PlanarPoint[]>;
}

/** Reject water when solid footprints occupy a substantial share of its actual area. */
export function createWaterBuildingOverlapFilter(
  buildings: readonly Footprint[],
  cellSize: number,
  minimumOverlapFraction = 0.25,
): (water: Footprint) => boolean {
  const index = new PlanarCellIndex<Footprint>(cellSize);
  const triangles = new Map<Footprint, PlanarPoint[][]>();
  for (const building of buildings) {
    if (building.outline.length >= 3) index.add(building, pointBounds(building.outline));
  }
  return (water) => {
    const candidates = index.query(pointBounds(water.outline))
      .filter((building) => boundsOverlap(water.outline, building.outline));
    if (candidates.length === 0) return false;
    let remaining = triangulate(water);
    const area = remaining.reduce((sum, ring) => sum + polygonArea(ring), 0);
    if (area <= 1e-12) return false;
    for (const building of candidates) {
      let cutters = triangles.get(building);
      if (!cutters) {
        cutters = triangulate(building);
        triangles.set(building, cutters);
      }
      for (const cutter of cutters) {
        remaining = remaining.flatMap((piece) => boundsOverlap(piece, cutter)
          ? subtractConvex(piece, cutter) : [piece]);
      }
      const remainingArea = remaining.reduce((sum, ring) => sum + polygonArea(ring), 0);
      if (remainingArea <= area * (1 - minimumOverlapFraction) + area * 1e-9) return true;
    }
    return false;
  };
}

function triangulate(polygon: Footprint): PlanarPoint[][] {
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
