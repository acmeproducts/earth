import type { TerrainData } from "./TerrainData";
import { smoothstep } from "./MathUtils";
import { distanceToRing, pointInRing } from "./PlanarGeometry";

export interface TerrainLakePoint {
  x: number;
  z: number;
}

/** One OSM polygon piece projected into a terrain tile's local scene frame. */
export interface TerrainLakeSource {
  sourceId: string;
  outline: TerrainLakePoint[];
  holes: TerrainLakePoint[][];
}

export interface TerrainLakePolygon extends TerrainLakeSource {
  elevationMeters: number;
}

export interface TerrainLakePolygonOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  minimumElevationMeters?: number;
  shorelineBlendMeters?: number;
  lakeBedDepthMeters?: number;
  rasterRepairMeters?: number;
  rasterRepairFadeMeters?: number;
  /** Tile-clipped rings returned for water rendering after padded rings shape terrain. */
  surfaceSources?: readonly TerrainLakeSource[];
  /** Makes every streamed piece of one OSM lake reuse exactly one level. */
  sharedLakeElevations?: Map<string, number>;
}

/** Maximum default distance at which an OSM lake can alter neighboring terrain. */
export const LAKE_TERRAIN_CONTEXT_METERS = 240;

/** Low shoreline samples capture outlets without letting steep banks set the lake level. */
const LAKE_SHORE_LEVEL_PERCENTILE = 0.15;

interface Bounds {
  minimumX: number;
  maximumX: number;
  minimumZ: number;
  maximumZ: number;
}

interface PreparedLake {
  polygon: TerrainLakePolygon;
  bounds: Bounds;
}

/**
 * Shapes terrain from the same OSM rings used by the water mesh. WorldCover's
 * older raster carve is restored around the vector edge before a short,
 * smooth shoreline and shallow submerged bed are applied.
 */
export async function conformTerrainToLakePolygons(
  terrain: TerrainData,
  rawElevations: Float32Array,
  sources: readonly TerrainLakeSource[],
  options: TerrainLakePolygonOptions,
  yieldControl?: () => Promise<void>,
): Promise<TerrainLakePolygon[]> {
  if (rawElevations.length !== terrain.width * terrain.height) {
    throw new Error("Lake elevation source must match the terrain grid.");
  }
  if (sources.length === 0) return [];

  const levels = lakeLevels(sources, terrain, rawElevations, options);
  const minimumElevation = options.minimumElevationMeters ?? 1;
  const lakes: PreparedLake[] = sources.flatMap((source) => {
    const elevationMeters = levels.get(source.sourceId);
    if (elevationMeters === undefined || elevationMeters < minimumElevation) return [];
    return [{
      polygon: { ...source, elevationMeters },
      bounds: polygonBounds(source),
    }];
  });
  if (lakes.length === 0) return [];

  const carvedElevations = terrain.elevations.slice();
  const shorelineWidth = (options.shorelineBlendMeters ?? 24) / options.metersPerUnit;
  const repairWidth = Math.max(
    shorelineWidth,
    (options.rasterRepairMeters ?? LAKE_TERRAIN_CONTEXT_METERS) / options.metersPerUnit,
  );
  const repairFadeWidth = Math.min(
    repairWidth,
    (options.rasterRepairFadeMeters ?? 40) / options.metersPerUnit,
  );
  const fullRepairWidth = repairWidth - repairFadeWidth;
  const sampleSpacing = Math.max(
    options.meshWidth / Math.max(1, terrain.width - 1),
    options.meshDepth / Math.max(1, terrain.height - 1),
  );
  const bedSlopeWidth = Math.max(shorelineWidth * 0.5, sampleSpacing);
  const bedDepth = options.lakeBedDepthMeters ?? 2;

  for (let row = 0; row < terrain.height; row++) {
    const z = (0.5 - row / Math.max(1, terrain.height - 1)) * options.meshDepth;
    for (let column = 0; column < terrain.width; column++) {
      const x = (column / Math.max(1, terrain.width - 1) - 0.5) * options.meshWidth;
      let repair = 0;
      let targetSum = 0;
      let targetWeight = 0;
      let strongestShore = 0;

      for (const { polygon, bounds } of lakes) {
        if (!withinExpandedBounds(x, z, bounds, repairWidth)) continue;
        const inside = pointInLake(x, z, polygon);
        const distance = distanceToRings(x, z, polygon);
        repair = Math.max(repair, inside || distance <= fullRepairWidth
          ? 1
          : 1 - smoothstep(fullRepairWidth, repairWidth, distance));
        if (!inside && distance >= shorelineWidth) continue;

        const shore = inside ? 1 : 1 - smoothstep(0, shorelineWidth, distance);
        const depth = inside ? bedDepth * smoothstep(0, bedSlopeWidth, distance) : 0;
        targetSum += (polygon.elevationMeters - depth) * shore;
        targetWeight += shore;
        strongestShore = Math.max(strongestShore, shore);
      }

      const index = row * terrain.width + column;
      const restored = carvedElevations[index] +
        (rawElevations[index] - carvedElevations[index]) * repair;
      terrain.elevations[index] = targetWeight === 0
        ? restored
        : restored + (targetSum / targetWeight - restored) * strongestShore;
    }
    await yieldControl?.();
  }

  updateElevationRange(terrain);
  const surfaceSources = options.surfaceSources ?? sources;
  return surfaceSources.flatMap((source) => {
    const elevationMeters = levels.get(source.sourceId);
    return elevationMeters === undefined || elevationMeters < minimumElevation
      ? []
      : [{ ...source, elevationMeters }];
  });
}

/** Estimates one level once, then shares it with every later streamed piece. */
function lakeLevels(
  sources: readonly TerrainLakeSource[],
  terrain: TerrainData,
  elevations: Float32Array,
  options: TerrainLakePolygonOptions,
): Map<string, number> {
  const groups = new Map<string, TerrainLakeSource[]>();
  for (const source of sources) {
    const pieces = groups.get(source.sourceId);
    if (pieces) pieces.push(source);
    else groups.set(source.sourceId, [source]);
  }

  const levels = new Map<string, number>();
  for (const [sourceId, pieces] of groups) {
    const shared = options.sharedLakeElevations?.get(sourceId);
    if (shared !== undefined) {
      levels.set(sourceId, shared);
      continue;
    }

    const interiorSamples: number[] = [];
    const shoreSamples: number[] = [];
    const bounds = combinedBounds(pieces);
    const sampleSpacing = Math.max(
      options.meshWidth / Math.max(1, terrain.width - 1),
      options.meshDepth / Math.max(1, terrain.height - 1),
    );
    const shoreSampleWidth = Math.max(
      (options.shorelineBlendMeters ?? 24) / options.metersPerUnit,
      sampleSpacing * 2,
    );
    const columns = gridRange(
      bounds.minimumX - shoreSampleWidth,
      bounds.maximumX + shoreSampleWidth,
      options.meshWidth,
      terrain.width,
      false,
    );
    const rows = gridRange(
      bounds.minimumZ - shoreSampleWidth,
      bounds.maximumZ + shoreSampleWidth,
      options.meshDepth,
      terrain.height,
      true,
    );
    for (let row = rows.minimum; row <= rows.maximum; row++) {
      const z = (0.5 - row / Math.max(1, terrain.height - 1)) * options.meshDepth;
      for (let column = columns.minimum; column <= columns.maximum; column++) {
        const x = (column / Math.max(1, terrain.width - 1) - 0.5) * options.meshWidth;
        const elevation = elevations[row * terrain.width + column];
        if (pieces.some((piece) => pointInLake(x, z, piece))) {
          interiorSamples.push(elevation);
          continue;
        }
        if (pieces.some((piece) => distanceToRings(x, z, piece) <= shoreSampleWidth)) {
          shoreSamples.push(elevation);
        }
      }
    }
    if (interiorSamples.length === 0 && shoreSamples.length === 0) {
      for (const piece of pieces) {
        for (const point of piece.outline) {
          shoreSamples.push(sampleGridElevation(
            terrain,
            point.x,
            point.z,
            options.meshWidth,
            options.meshDepth,
            elevations,
          ));
        }
      }
    }
    if (interiorSamples.length === 0 && shoreSamples.length === 0) continue;
    interiorSamples.sort((a, b) => a - b);
    shoreSamples.sort((a, b) => a - b);
    const interiorLevel = interiorSamples.length === 0
      ? Infinity
      : percentile(interiorSamples, 0.5);
    const shoreLevel = shoreSamples.length === 0
      ? Infinity
      : percentile(shoreSamples, LAKE_SHORE_LEVEL_PERCENTILE);
    const level = Math.min(interiorLevel, shoreLevel);
    levels.set(sourceId, level);
    options.sharedLakeElevations?.set(sourceId, level);
  }
  return levels;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.floor(Math.max(0, Math.min(1, fraction)) * (sorted.length - 1))];
}

function sampleGridElevation(
  terrain: TerrainData,
  x: number,
  z: number,
  meshWidth: number,
  meshDepth: number,
  elevations: Float32Array,
): number {
  const px = Math.max(0, Math.min(terrain.width - 1, (x / meshWidth + 0.5) * (terrain.width - 1)));
  const py = Math.max(0, Math.min(terrain.height - 1, (0.5 - z / meshDepth) * (terrain.height - 1)));
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, terrain.width - 1);
  const y1 = Math.min(y0 + 1, terrain.height - 1);
  const fx = px - x0;
  const fy = py - y0;
  const top = elevations[y0 * terrain.width + x0] * (1 - fx) +
    elevations[y0 * terrain.width + x1] * fx;
  const bottom = elevations[y1 * terrain.width + x0] * (1 - fx) +
    elevations[y1 * terrain.width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

function pointInLake(x: number, z: number, polygon: TerrainLakeSource): boolean {
  const point = { x, z };
  return pointInRing(point, polygon.outline) &&
    !polygon.holes.some((hole) => pointInRing(point, hole));
}

function distanceToRings(x: number, z: number, polygon: TerrainLakeSource): number {
  const point = { x, z };
  return Math.min(
    distanceToRing(point, polygon.outline),
    ...polygon.holes.map((hole) => distanceToRing(point, hole)),
  );
}

function polygonBounds(polygon: TerrainLakeSource): Bounds {
  return polygon.outline.reduce((bounds, point) => ({
    minimumX: Math.min(bounds.minimumX, point.x),
    maximumX: Math.max(bounds.maximumX, point.x),
    minimumZ: Math.min(bounds.minimumZ, point.z),
    maximumZ: Math.max(bounds.maximumZ, point.z),
  }), emptyBounds());
}

function combinedBounds(polygons: readonly TerrainLakeSource[]): Bounds {
  return polygons.reduce((combined, polygon) => {
    const bounds = polygonBounds(polygon);
    return {
      minimumX: Math.min(combined.minimumX, bounds.minimumX),
      maximumX: Math.max(combined.maximumX, bounds.maximumX),
      minimumZ: Math.min(combined.minimumZ, bounds.minimumZ),
      maximumZ: Math.max(combined.maximumZ, bounds.maximumZ),
    };
  }, emptyBounds());
}

function emptyBounds(): Bounds {
  return { minimumX: Infinity, maximumX: -Infinity, minimumZ: Infinity, maximumZ: -Infinity };
}

function withinExpandedBounds(x: number, z: number, bounds: Bounds, margin: number): boolean {
  return x >= bounds.minimumX - margin && x <= bounds.maximumX + margin &&
    z >= bounds.minimumZ - margin && z <= bounds.maximumZ + margin;
}

function gridRange(
  minimum: number,
  maximum: number,
  size: number,
  count: number,
  reversed: boolean,
): { minimum: number; maximum: number } {
  const toIndex = (coordinate: number): number =>
    (reversed ? 0.5 - coordinate / size : coordinate / size + 0.5) * Math.max(1, count - 1);
  const a = toIndex(minimum);
  const b = toIndex(maximum);
  return {
    minimum: Math.max(0, Math.floor(Math.min(a, b))),
    maximum: Math.min(count - 1, Math.ceil(Math.max(a, b))),
  };
}

function updateElevationRange(terrain: TerrainData): void {
  terrain.minElevation = Infinity;
  terrain.maxElevation = -Infinity;
  for (const elevation of terrain.elevations) {
    terrain.minElevation = Math.min(terrain.minElevation, elevation);
    terrain.maxElevation = Math.max(terrain.maxElevation, elevation);
  }
}
