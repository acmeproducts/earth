import type { TerrainData } from "./TerrainData";

export type TerrainEdgeElevationCache = Map<string, number>;

/** Makes independently processed tiles reuse one final height at every shared edge sample. */
export function stitchTerrainEdges(
  terrain: TerrainData,
  sharedElevations: TerrainEdgeElevationCache,
): void {
  const xIntervals = terrain.width - 1;
  const yIntervals = terrain.height - 1;
  if (xIntervals < 1 || yIntervals < 1) return;

  const stitch = (x: number, y: number): void => {
    const key = terrainEdgeSampleKey(terrain, x, y);
    const index = y * terrain.width + x;
    const shared = sharedElevations.get(key);
    if (shared === undefined) sharedElevations.set(key, terrain.elevations[index]);
    else terrain.elevations[index] = shared;
  };

  for (let x = 0; x < terrain.width; x++) {
    stitch(x, 0);
    stitch(x, terrain.height - 1);
  }
  for (let y = 1; y < terrain.height - 1; y++) {
    stitch(0, y);
    stitch(terrain.width - 1, y);
  }

  terrain.minElevation = Infinity;
  terrain.maxElevation = -Infinity;
  for (const elevation of terrain.elevations) {
    terrain.minElevation = Math.min(terrain.minElevation, elevation);
    terrain.maxElevation = Math.max(terrain.maxElevation, elevation);
  }
}

/** Makes a dense mesh boundary follow the exact piecewise-linear profile of its coarse LOD. */
export function stitchTerrainMeshEdges(
  positions: Float32Array | number[],
  subdivisions: number,
  edgeSubdivisions: number,
): void {
  const coarse = Math.max(1, Math.round(edgeSubdivisions));
  if (subdivisions <= coarse || subdivisions % coarse !== 0) return;
  const verticesPerRow = subdivisions + 1;
  const stride = subdivisions / coarse;

  const linearize = (vertexAt: (position: number) => number): void => {
    for (let segment = 0; segment < coarse; segment++) {
      const start = vertexAt(segment * stride) * 3 + 1;
      const end = vertexAt((segment + 1) * stride) * 3 + 1;
      const startHeight = positions[start];
      const endHeight = positions[end];
      for (let offset = 1; offset < stride; offset++) {
        const index = vertexAt(segment * stride + offset) * 3 + 1;
        positions[index] = startHeight + (endHeight - startHeight) * offset / stride;
      }
    }
  };

  linearize((column) => column);
  linearize((column) => subdivisions * verticesPerRow + column);
  linearize((row) => row * verticesPerRow);
  linearize((row) => row * verticesPerRow + subdivisions);
}

function terrainEdgeSampleKey(terrain: TerrainData, x: number, y: number): string {
  const worldX = terrain.worldTile.x + x / (terrain.width - 1);
  const worldY = terrain.worldTile.y + y / (terrain.height - 1);
  return `${terrain.worldTile.level}/${worldX.toFixed(12)}/${worldY.toFixed(12)}`;
}
