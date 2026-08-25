import type { TerrainData } from "./TerrainData";

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
  /** Makes every streamed piece of one OSM lake reuse exactly one level. */
  sharedLakeElevations?: Map<string, number>;
}

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
    (options.rasterRepairMeters ?? 240) / options.metersPerUnit,
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
  return lakes.map(({ polygon }) => polygon);
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

    const samples: number[] = [];
    const bounds = combinedBounds(pieces);
    const columns = gridRange(bounds.minimumX, bounds.maximumX, options.meshWidth, terrain.width, false);
    const rows = gridRange(bounds.minimumZ, bounds.maximumZ, options.meshDepth, terrain.height, true);
    for (let row = rows.minimum; row <= rows.maximum; row++) {
      const z = (0.5 - row / Math.max(1, terrain.height - 1)) * options.meshDepth;
      for (let column = columns.minimum; column <= columns.maximum; column++) {
        const x = (column / Math.max(1, terrain.width - 1) - 0.5) * options.meshWidth;
        if (pieces.some((piece) => pointInLake(x, z, piece))) {
          samples.push(elevations[row * terrain.width + column]);
        }
      }
    }
    if (samples.length === 0) {
      for (const piece of pieces) {
        for (const point of piece.outline) {
          samples.push(sampleGridElevation(
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
    if (samples.length === 0) continue;
    samples.sort((a, b) => a - b);
    const level = samples[Math.floor(samples.length / 2)];
    levels.set(sourceId, level);
    options.sharedLakeElevations?.set(sourceId, level);
  }
  return levels;
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
  return pointInRing(x, z, polygon.outline) &&
    !polygon.holes.some((hole) => pointInRing(x, z, hole));
}

function pointInRing(x: number, z: number, points: readonly TerrainLakePoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index];
    const b = points[previous];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToRings(x: number, z: number, polygon: TerrainLakeSource): number {
  return Math.min(
    distanceToRing(x, z, polygon.outline),
    ...polygon.holes.map((hole) => distanceToRing(x, z, hole)),
  );
}

function distanceToRing(x: number, z: number, points: readonly TerrainLakePoint[]): number {
  let distance = Infinity;
  for (let index = 0; index < points.length; index++) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    const amount = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - start.x) * dx + (z - start.z) * dz) / lengthSquared));
    distance = Math.min(distance, Math.hypot(
      x - (start.x + dx * amount),
      z - (start.z + dz * amount),
    ));
  }
  return distance;
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

function smoothstep(minimum: number, maximum: number, value: number): number {
  const amount = Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  return amount * amount * (3 - 2 * amount);
}

function updateElevationRange(terrain: TerrainData): void {
  terrain.minElevation = Infinity;
  terrain.maxElevation = -Infinity;
  for (const elevation of terrain.elevations) {
    terrain.minElevation = Math.min(terrain.minElevation, elevation);
    terrain.maxElevation = Math.max(terrain.maxElevation, elevation);
  }
}
