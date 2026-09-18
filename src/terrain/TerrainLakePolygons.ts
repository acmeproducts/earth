import { visitTerrainRaster } from "./TerrainRaster";
import { ringEdges } from "../core/Geometry2D";
import { sampleGridBilinear, bilinear } from "../core/GridSampling";
import type { TerrainData } from "./TerrainData";
import type { SharedValueMap } from "../core/OwnedValueCache";
import { smoothstep } from "../core/MathUtils";
import { distanceToRing, pointInRing, signedArea } from "../core/PlanarGeometry";
import type { StreamingTrace } from "../diagnostics/StreamingDiagnostics";

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
  sharedLakeElevations?: SharedValueMap<string, number>;
  /** Enables small-water plausibility checks using the renderer's vertical offset. */
  smallWaterSurfaceClearanceMeters?: number;
  /**
   * Widest vertex spacing any mesh renders this terrain with, in scene units.
   * The bed keeps a level shelf this wide inside the outline so a coarse mesh
   * interpolating between a bed vertex and a bank vertex still carries the
   * water edge. Defaults to the terrain sample spacing.
   */
  renderedVertexSpacing?: number;
}

/** Maximum default distance at which an OSM lake can alter neighboring terrain. */
export const LAKE_TERRAIN_CONTEXT_METERS = 240;

/** Low shoreline samples capture outlets without letting steep banks set the lake level. */
const LAKE_SHORE_LEVEL_PERCENTILE = 0.05;
const LAKE_INTERIOR_LEVEL_PERCENTILE = 0.15;
/** Allow small DEM seams, never manufacture tall banks to hold up water. */
const LAKE_MAX_TERRAIN_RAISE_METERS = 0.5;

const SMALL_WATER_MAX_AREA_METERS_SQUARED = 500;
const SMALL_WATER_FLOATING_GAP_METERS = 0.25;

interface Bounds {
  minimumX: number;
  maximumX: number;
  minimumZ: number;
  maximumZ: number;
}

interface PreparedLake {
  polygon: TerrainLakePolygon;
  bounds: Bounds;
  /** False for context pieces whose level this tile cannot judge: repair only. */
  shapes: boolean;
}

/**
 * Shapes terrain from the same OSM rings used by the water mesh. WorldCover's
 * older raster carve is restored around the vector edge before a short,
 * smooth shoreline and submerged bed are applied. Existing deeper ground is
 * retained; fitting the mapped water must not build a plateau around it.
 */
export async function conformTerrainToLakePolygons(
  terrain: TerrainData,
  rawElevations: Float32Array,
  sources: readonly TerrainLakeSource[],
  options: TerrainLakePolygonOptions,
  yieldControl?: () => Promise<void>,
  trace?: StreamingTrace,
): Promise<TerrainLakePolygon[]> {
  if (rawElevations.length !== terrain.width * terrain.height) {
    throw new Error("Lake elevation source must match the terrain grid.");
  }
  if (sources.length === 0) return [];

  trace?.stage("lake level sampling and plausibility checks", "synchronous");
  const levels = lakeLevels(sources, terrain, rawElevations, options);
  trace?.stage("lake shaping preparation", "synchronous");
  const minimumElevation = options.minimumElevationMeters ?? 1;
  const lakes: PreparedLake[] = sources.flatMap((source) => {
    const elevationMeters = levels.get(source.sourceId);
    if (elevationMeters !== undefined && elevationMeters < minimumElevation) return [];
    // Off-grid context pieces still restore the raster carve reaching into
    // this tile; their level is left to the tile that actually contains them.
    return [{
      polygon: { ...source, elevationMeters: elevationMeters ?? Number.NaN },
      bounds: polygonBounds(source),
      shapes: elevationMeters !== undefined,
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
  // Every vertex within one rendered cell diagonal of the outline stays at the
  // water level, so linear interpolation across the outline cannot dip below it.
  const shelfWidth = Math.max(sampleSpacing, options.renderedVertexSpacing ?? 0) * Math.SQRT2;

  trace?.stage("lake terrain raster shaping");
  await visitTerrainRaster(terrain, options, (index, x, z) => {
    let repair = 0;
    let targetSum = 0;
    let targetWeight = 0;
    let strongestShore = 0;

    for (const { polygon, bounds, shapes } of lakes) {
      if (!withinExpandedBounds(x, z, bounds, repairWidth)) continue;
      const inside = pointInLake(x, z, polygon);
      const distance = distanceToRings(x, z, polygon);
      repair = Math.max(repair, inside || distance <= fullRepairWidth
        ? 1
        : 1 - smoothstep(fullRepairWidth, repairWidth, distance));
      if (!shapes || (!inside && distance >= shorelineWidth)) continue;

      const shore = inside ? 1 : 1 - smoothstep(0, shorelineWidth, distance);
      const depth = inside
        ? bedDepth * smoothstep(shelfWidth, shelfWidth + bedSlopeWidth, distance)
        : 0;
      targetSum += (polygon.elevationMeters - depth) * shore;
      targetWeight += shore;
      strongestShore = Math.max(strongestShore, shore);
    }

    const restored = carvedElevations[index] +
      (rawElevations[index] - carvedElevations[index]) * repair;
    const shaped = targetWeight === 0
      ? restored
      : restored + (targetSum / targetWeight - restored) * strongestShore;
    // Bound only lake shaping, not restoration of an obsolete raster carve.
    // Use raw DEM heights so repeated shaping cannot accumulate uplift.
    terrain.elevations[index] = Math.min(
      shaped,
      Math.max(restored, rawElevations[index] + LAKE_MAX_TERRAIN_RAISE_METERS),
    );
  }, yieldControl);

  trace?.stage("lake elevation range and surface assembly", "synchronous");
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
      if (!isUnsupportedSmallWater(pieces, shared, terrain, elevations, options)) {
        levels.set(sourceId, shared);
      }
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
    // A context piece beyond this grid has no water surface of its own here.
    // Bank samples from one side alone overestimate the level (they miss the
    // outlet side and the DEM water surface), and publishing that would leave
    // the tile owning the lake unable to fit its own shore. Leave it to that tile.
    if (interiorSamples.length === 0 &&
        (shoreSamples.length === 0 || !withinGrid(bounds, options))) continue;
    interiorSamples.sort((a, b) => a - b);
    shoreSamples.sort((a, b) => a - b);
    const interiorLevel = interiorSamples.length === 0
      ? Infinity
      : percentile(interiorSamples, LAKE_INTERIOR_LEVEL_PERCENTILE);
    const shoreLevel = shoreSamples.length === 0
      ? Infinity
      : percentile(shoreSamples, LAKE_SHORE_LEVEL_PERCENTILE);
    const level = Math.min(interiorLevel, shoreLevel);
    if (isUnsupportedSmallWater(pieces, level, terrain, elevations, options)) continue;
    levels.set(sourceId, level);
    options.sharedLakeElevations?.set(sourceId, level);
  }
  return levels;
}

/** Test unmodified terrain: lake shaping would manufacture its own supporting banks. */
function isUnsupportedSmallWater(
  pieces: readonly TerrainLakeSource[],
  level: number,
  terrain: TerrainData,
  elevations: Float32Array,
  options: TerrainLakePolygonOptions,
): boolean {
  const clearance = options.smallWaterSurfaceClearanceMeters;
  if (clearance === undefined) return false;
  const bounds = combinedBounds(pieces);
  const margin = 2 / options.metersPerUnit;
  // Never classify clipped or off-tile context as an entire small water body.
  if (bounds.minimumX <= -options.meshWidth / 2 + margin ||
      bounds.maximumX >= options.meshWidth / 2 - margin ||
      bounds.minimumZ <= -options.meshDepth / 2 + margin ||
      bounds.maximumZ >= options.meshDepth / 2 - margin) return false;
  const area = pieces.reduce((sum, piece) => sum + Math.max(0,
    Math.abs(signedArea(piece.outline)) -
    piece.holes.reduce((holes, ring) => holes + Math.abs(signedArea(ring)), 0)), 0) *
    options.metersPerUnit ** 2;
  if (area > SMALL_WATER_MAX_AREA_METERS_SQUARED) return false;

  let perimeter = 0;
  let unsupported = 0;
  for (const piece of pieces) {
    for (const [a, b] of ringEdges(piece.outline)) {
      const length = Math.hypot(b.x - a.x, b.z - a.z) * options.metersPerUnit;
      if (length === 0) continue;
      const count = Math.max(1, Math.ceil(length / 2));
      for (const { x, z } of segmentMidpointSamples(a, b, count)) {
        const dx = -(b.z - a.z) * 2 / length;
        const dz = (b.x - a.x) * 2 / length;
        const side = pieces.some((candidate) => pointInLake(x + dx, z + dz, candidate)) ? -1 : 1;
        const ground = sampleGridElevation(terrain,
          x + dx * side, z + dz * side,
          options.meshWidth, options.meshDepth, elevations);
        if (!Number.isFinite(ground)) return false;
        perimeter += length / count;
        if (level + clearance - ground > SMALL_WATER_FLOATING_GAP_METERS) {
          unsupported += length / count;
        }
      }
    }
  }
  return perimeter > 0 && unsupported / perimeter >= 0.75;
}

export interface LakeSupportOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  /** Vertex grid the ground is rendered with; defaults to the terrain sample grid. */
  meshSubdivisions?: number;
  sampleStepMeters?: number;
}

export interface LakeSupportReport {
  sourceId: string;
  elevationMeters: number;
  perimeterMeters: number;
  /** Share of the outline under which the rendered ground lies below the water level. */
  unsupportedFraction: number;
  /** Largest drop from the water level to the rendered ground under the outline. */
  maxGapMeters: number;
}

/**
 * Measures how well the rendered ground carries each water outline. A mesh
 * interpolates linearly between its vertices, so the ground is sampled the way
 * the vertex grid of the given subdivision count would render it.
 */
export function measureLakeSupport(
  terrain: TerrainData,
  polygons: readonly TerrainLakePolygon[],
  options: LakeSupportOptions,
  elevations: Float32Array = terrain.elevations,
): LakeSupportReport[] {
  const subdivisions = Math.max(1, Math.round(
    options.meshSubdivisions ?? Math.max(terrain.width, terrain.height) - 1,
  ));
  const step = (options.sampleStepMeters ?? 2) / options.metersPerUnit;
  const tolerance = 0.05;
  const halfWidth = options.meshWidth / 2;
  const halfDepth = options.meshDepth / 2;
  const edgeEpsilon = 1e-6 * Math.max(options.meshWidth, options.meshDepth);
  // Segments running along the tile boundary are clip edges over open water,
  // not shores, so they carry no information about shoreline support.
  const onTileEdge = (a: TerrainLakePoint, b: TerrainLakePoint): boolean =>
    (Math.abs(Math.abs(a.x) - halfWidth) < edgeEpsilon &&
      Math.abs(Math.abs(b.x) - halfWidth) < edgeEpsilon && Math.sign(a.x) === Math.sign(b.x)) ||
    (Math.abs(Math.abs(a.z) - halfDepth) < edgeEpsilon &&
      Math.abs(Math.abs(b.z) - halfDepth) < edgeEpsilon && Math.sign(a.z) === Math.sign(b.z));
  return polygons.map((polygon) => {
    let perimeter = 0;
    let unsupported = 0;
    let maxGap = 0;
    for (const ring of [polygon.outline, ...polygon.holes]) {
      for (const [a, b] of ringEdges(ring)) {
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length === 0 || onTileEdge(a, b)) continue;
        const count = Math.max(1, Math.ceil(length / step));
        for (const { x, z } of segmentMidpointSamples(a, b, count)) {
          if (x < -halfWidth || x > halfWidth || z < -halfDepth || z > halfDepth) continue;
          const ground = sampleMeshElevation(terrain, x, z, options, subdivisions, elevations);
          const gap = polygon.elevationMeters - ground;
          perimeter += length / count;
          if (gap > tolerance) {
            unsupported += length / count;
            maxGap = Math.max(maxGap, gap);
          }
        }
      }
    }
    return {
      sourceId: polygon.sourceId,
      elevationMeters: polygon.elevationMeters,
      perimeterMeters: perimeter * options.metersPerUnit,
      unsupportedFraction: perimeter > 0 ? unsupported / perimeter : 0,
      maxGapMeters: maxGap,
    };
  });
}

/** Ground height as a mesh with the given subdivisions renders it at (x, z). */
function sampleMeshElevation(
  terrain: TerrainData,
  x: number,
  z: number,
  options: Pick<LakeSupportOptions, "meshWidth" | "meshDepth">,
  subdivisions: number,
  elevations: Float32Array,
): number {
  const u = Math.max(0, Math.min(1, x / options.meshWidth + 0.5));
  const v = Math.max(0, Math.min(1, 0.5 - z / options.meshDepth));
  const cu = u * subdivisions;
  const cv = v * subdivisions;
  const u0 = Math.min(Math.floor(cu), subdivisions - 1);
  const v0 = Math.min(Math.floor(cv), subdivisions - 1);
  const fu = cu - u0;
  const fv = cv - v0;
  const vertex = (column: number, row: number): number => sampleGridElevation(
    terrain,
    (column / subdivisions - 0.5) * options.meshWidth,
    (0.5 - row / subdivisions) * options.meshDepth,
    options.meshWidth,
    options.meshDepth,
    elevations,
  );
  return bilinear(vertex(u0, v0), vertex(u0 + 1, v0),
    vertex(u0, v0 + 1), vertex(u0 + 1, v0 + 1), fu, fv);
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
  return sampleGridBilinear(elevations, terrain.width, terrain.height, px, py);
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

function withinGrid(
  bounds: Bounds,
  options: Pick<TerrainLakePolygonOptions, "meshWidth" | "meshDepth">,
): boolean {
  return bounds.minimumX >= -options.meshWidth / 2 && bounds.maximumX <= options.meshWidth / 2 &&
    bounds.minimumZ >= -options.meshDepth / 2 && bounds.maximumZ <= options.meshDepth / 2;
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

function* segmentMidpointSamples(a: TerrainLakePoint, b: TerrainLakePoint, count: number) {
  for (let sample = 0; sample < count; sample++) {
    const t = (sample + 0.5) / count;
    yield { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  }
}
