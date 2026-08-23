import type { TerrainData } from "./TerrainData";

export type TerrainEdgeElevationCache = Map<string, number>;

export interface TerrainSkirtGeometry {
  positions: Float32Array;
  uvs: Float32Array;
  colors?: Float32Array;
  indices: Uint32Array;
}

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

/** Builds non-colliding walls below a terrain boundary so tiny render gaps cannot reveal water. */
export function createTerrainSkirtGeometry(
  surfacePositions: Float32Array | number[],
  surfaceUvs: Float32Array | number[],
  subdivisions: number,
  bottomY: number,
  surfaceColors?: Float32Array | number[],
  overlap = 0,
  surfaceDrop = 0,
): TerrainSkirtGeometry {
  const rowSize = subdivisions + 1;
  if (subdivisions < 1 || surfacePositions.length < rowSize * rowSize * 3) {
    return {
      positions: new Float32Array(),
      uvs: new Float32Array(),
      colors: surfaceColors ? new Float32Array() : undefined,
      indices: new Uint32Array(),
    };
  }

  const boundary: number[] = [];
  for (let column = 0; column < subdivisions; column++) boundary.push(column);
  for (let row = 0; row < subdivisions; row++) {
    boundary.push(row * rowSize + subdivisions);
  }
  for (let column = subdivisions; column > 0; column--) {
    boundary.push(subdivisions * rowSize + column);
  }
  for (let row = subdivisions; row > 0; row--) boundary.push(row * rowSize);

  // Each segment owns separate cap and wall vertices so their normals cannot
  // average into a dark diagonal at the fold.
  const positions = new Float32Array(boundary.length * 8 * 3);
  const uvs = new Float32Array(boundary.length * 8 * 2);
  const colors = surfaceColors ? new Float32Array(boundary.length * 8 * 4) : undefined;
  const indices = new Uint32Array(boundary.length * 24);

  const copyVertex = (source: number, target: number, y?: number): void => {
    positions[target * 3] = surfacePositions[source * 3];
    positions[target * 3 + 1] = y ?? surfacePositions[source * 3 + 1];
    positions[target * 3 + 2] = surfacePositions[source * 3 + 2];
    uvs[target * 2] = surfaceUvs[source * 2];
    uvs[target * 2 + 1] = surfaceUvs[source * 2 + 1];
    if (colors && surfaceColors) {
      for (let channel = 0; channel < 4; channel++) {
        colors[target * 4 + channel] = surfaceColors[source * 4 + channel];
      }
    }
  };

  const segmentOutward = (start: number, end: number): [number, number] => {
    const dx = surfacePositions[end * 3] - surfacePositions[start * 3];
    const dz = surfacePositions[end * 3 + 2] - surfacePositions[start * 3 + 2];
    const length = Math.max(Number.EPSILON, Math.hypot(dx, dz));
    return [-dz / length, dx / length];
  };

  const outerOffset = (boundaryIndex: number): [number, number] => {
    const previous = boundary[(boundaryIndex - 1 + boundary.length) % boundary.length];
    const current = boundary[boundaryIndex];
    const next = boundary[(boundaryIndex + 1) % boundary.length];
    const incoming = segmentOutward(previous, current);
    const outgoing = segmentOutward(current, next);
    const miterX = incoming[0] + outgoing[0];
    const miterZ = incoming[1] + outgoing[1];
    const projection = miterX * outgoing[0] + miterZ * outgoing[1];
    if (Math.abs(projection) <= Number.EPSILON) {
      return [outgoing[0] * overlap, outgoing[1] * overlap];
    }
    return [miterX * overlap / projection, miterZ * overlap / projection];
  };

  for (let segment = 0; segment < boundary.length; segment++) {
    const start = boundary[segment];
    const end = boundary[(segment + 1) % boundary.length];
    const vertex = segment * 8;
    const startOffset = outerOffset(segment);
    const endOffset = outerOffset((segment + 1) % boundary.length);
    copyVertex(start, vertex);
    copyVertex(end, vertex + 1);
    copyVertex(start, vertex + 2, surfacePositions[start * 3 + 1] - surfaceDrop);
    copyVertex(end, vertex + 3, surfacePositions[end * 3 + 1] - surfaceDrop);
    copyVertex(start, vertex + 4, surfacePositions[start * 3 + 1] - surfaceDrop);
    copyVertex(end, vertex + 5, surfacePositions[end * 3 + 1] - surfaceDrop);
    copyVertex(start, vertex + 6, bottomY);
    copyVertex(end, vertex + 7, bottomY);
    for (const outerVertex of [vertex + 2, vertex + 4, vertex + 6]) {
      positions[outerVertex * 3] += startOffset[0];
      positions[outerVertex * 3 + 2] += startOffset[1];
    }
    for (const outerVertex of [vertex + 3, vertex + 5, vertex + 7]) {
      positions[outerVertex * 3] += endOffset[0];
      positions[outerVertex * 3 + 2] += endOffset[1];
    }

    const index = segment * 24;
    indices.set([
      vertex, vertex + 2, vertex + 1,
      vertex + 1, vertex + 2, vertex + 3,
      vertex + 1, vertex + 2, vertex,
      vertex + 3, vertex + 2, vertex + 1,
      vertex + 4, vertex + 6, vertex + 5,
      vertex + 5, vertex + 6, vertex + 7,
      vertex + 5, vertex + 6, vertex + 4,
      vertex + 7, vertex + 6, vertex + 5,
    ], index);
  }

  return { positions, uvs, colors, indices };
}

function terrainEdgeSampleKey(terrain: TerrainData, x: number, y: number): string {
  const worldX = terrain.worldTile.x + x / (terrain.width - 1);
  const worldY = terrain.worldTile.y + y / (terrain.height - 1);
  return `${terrain.worldTile.level}/${worldX.toFixed(12)}/${worldY.toFixed(12)}`;
}
