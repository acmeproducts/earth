import { TerrainResult, TileBounds } from "./TerrainTiles";

export const SEA_LEVEL_METERS = 0;

/** Horizontal feature mask used to keep scene objects clear of mapped surfaces. */
export interface HorizontalExclusionMask {
  intersects(x: number, z: number, radius: number): boolean;
}

const mercatorY = (latitude: number): number =>
  Math.asinh(Math.tan((latitude * Math.PI) / 180));

export function lonLatToScene(
  longitude: number,
  latitude: number,
  bounds: TileBounds,
  meshWidth: number,
  meshDepth: number,
): { x: number; z: number } {
  const u = (longitude - bounds.lonWest) / (bounds.lonEast - bounds.lonWest);
  const north = mercatorY(bounds.latNorth);
  const v = (north - mercatorY(latitude)) / (north - mercatorY(bounds.latSouth));
  return { x: (u - 0.5) * meshWidth, z: (0.5 - v) * meshDepth };
}

export function sceneToLonLat(
  x: number,
  z: number,
  bounds: TileBounds,
  meshWidth: number,
  meshDepth: number,
): { lon: number; lat: number } {
  const u = x / meshWidth + 0.5;
  const v = 0.5 - z / meshDepth;
  const north = mercatorY(bounds.latNorth);
  const projectedY = north - v * (north - mercatorY(bounds.latSouth));
  return {
    lon: bounds.lonWest + u * (bounds.lonEast - bounds.lonWest),
    lat: (Math.atan(Math.sinh(projectedY)) * 180) / Math.PI,
  };
}

export function sampleElevation(
  terrain: TerrainResult,
  x: number,
  z: number,
  meshWidth: number,
  meshDepth: number,
  elevations: Float32Array | number[] = terrain.elevations,
): number {
  const u = Math.min(1, Math.max(0, x / meshWidth + 0.5));
  const v = Math.min(1, Math.max(0, 0.5 - z / meshDepth));
  const px = u * (terrain.width - 1);
  const py = v * (terrain.height - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, terrain.width - 1);
  const y1 = Math.min(y0 + 1, terrain.height - 1);
  const fx = px - x0;
  const fy = py - y0;
  const values = elevations;

  return (
    values[y0 * terrain.width + x0] * (1 - fx) * (1 - fy) +
    values[y0 * terrain.width + x1] * fx * (1 - fy) +
    values[y1 * terrain.width + x0] * (1 - fx) * fy +
    values[y1 * terrain.width + x1] * fx * fy
  );
}

/** Returns true when the center and full rectangular footprint are above an elevation. */
export function isTerrainFootprintAbove(
  terrain: TerrainResult,
  x: number,
  z: number,
  halfWidth: number,
  halfDepth: number,
  meshWidth: number,
  meshDepth: number,
  minimumElevation = SEA_LEVEL_METERS,
): boolean {
  const offsets: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [-halfWidth, -halfDepth],
    [halfWidth, -halfDepth],
    [-halfWidth, halfDepth],
    [halfWidth, halfDepth],
  ];
  return offsets.every(([offsetX, offsetZ]) =>
    sampleElevation(terrain, x + offsetX, z + offsetZ, meshWidth, meshDepth) > minimumElevation
  );
}
