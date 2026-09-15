import { distanceToRing, pointBounds, pointInRing, type PlanarPoint } from "../core/PlanarGeometry";
import type { TerrainData } from "./TerrainData";

/** Bounds the surface under a footprint, including cells crossing its walls. */
export function buildingGroundElevation(
  terrain: TerrainData,
  outline: readonly PlanarPoint[],
  holes: readonly (readonly PlanarPoint[])[],
  meshWidth: number,
  meshDepth: number,
): number {
  const columns = Math.max(1, terrain.width - 1);
  const rows = Math.max(1, terrain.height - 1);
  const margin = Math.hypot(meshWidth / columns, meshDepth / rows);
  const bounds = pointBounds(outline);
  const firstColumn = Math.max(0, Math.ceil(((bounds.minX - margin) / meshWidth + 0.5) * columns));
  const lastColumn = Math.min(terrain.width - 1,
    Math.floor(((bounds.maxX + margin) / meshWidth + 0.5) * columns));
  const firstRow = Math.max(0, Math.ceil((0.5 - (bounds.maxZ + margin) / meshDepth) * rows));
  const lastRow = Math.min(terrain.height - 1,
    Math.floor((0.5 - (bounds.minZ - margin) / meshDepth) * rows));
  let elevation = -Infinity;
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) {
      const point = {
        x: (column / columns - 0.5) * meshWidth,
        z: (0.5 - row / rows) * meshDepth,
      };
      // Interpolated terrain cannot exceed its cell's highest corner. Include
      // a cell diagonal around walls so narrow footprints cannot miss a peak.
      if (!pointInRing(point, outline) && distanceToRing(point, outline) > margin) continue;
      if (holes.some((hole) => pointInRing(point, hole) && distanceToRing(point, hole) > margin)) continue;
      elevation = Math.max(elevation, terrain.elevations[row * terrain.width + column]);
    }
  }
  return elevation;
}
