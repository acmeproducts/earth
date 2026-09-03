interface GeographicBounds {
  lonWest: number;
  lonEast: number;
  latNorth: number;
  latSouth: number;
}

export interface SceneGeographicFrame {
  bounds: GeographicBounds;
  meshWidth: number;
  meshDepth: number;
}

interface ElevationGrid {
  elevations: Float32Array;
  width: number;
  height: number;
  minElevation: number;
  maxElevation: number;
}

export const SEA_LEVEL_METERS = 0;

/** Highest allowed terrain elevation beneath the ocean surface. */
export const SUBMERGED_TERRAIN_CEILING_METERS = -50;

/** Applies the submerged-terrain ceiling to one interpolated elevation. */
export function sinkSubmergedElevation(
  elevationMeters: number,
  waterLevelMeters = SEA_LEVEL_METERS,
  ceilingMeters = SUBMERGED_TERRAIN_CEILING_METERS,
): number {
  return elevationMeters <= waterLevelMeters
    ? Math.min(elevationMeters, ceilingMeters)
    : elevationMeters;
}

/**
 * Keeps every sea-level or submerged height sample safely below the rendered
 * water, even when no land-cover classification is available.
 */
export function sinkSubmergedTerrain(
  terrain: ElevationGrid,
  waterLevelMeters = SEA_LEVEL_METERS,
  ceilingMeters = SUBMERGED_TERRAIN_CEILING_METERS,
): void {
  terrain.minElevation = Infinity;
  terrain.maxElevation = -Infinity;
  for (let index = 0; index < terrain.elevations.length; index++) {
    const elevation = terrain.elevations[index];
    const corrected = sinkSubmergedElevation(
      elevation,
      waterLevelMeters,
      ceilingMeters,
    );
    terrain.elevations[index] = corrected;
    terrain.minElevation = Math.min(terrain.minElevation, corrected);
    terrain.maxElevation = Math.max(terrain.maxElevation, corrected);
  }
}

/** Horizontal feature mask used to keep scene objects clear of mapped surfaces. */
export interface HorizontalExclusionMask {
  intersects(x: number, z: number, radius: number): boolean;
}

export interface HorizontalPolygon {
  outer: ReadonlyArray<{ x: number; z: number }>;
  holes?: ReadonlyArray<ReadonlyArray<{ x: number; z: number }>>;
}

export interface HorizontalPoint {
  x: number;
  z: number;
}

export function pointSegmentDistanceSquared(
  x: number,
  z: number,
  start: HorizontalPoint,
  end: HorizontalPoint,
): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((x - start.x) * dx + (z - start.z) * dz) / lengthSquared));
  const offsetX = x - (start.x + dx * amount);
  const offsetZ = z - (start.z + dz * amount);
  return offsetX * offsetX + offsetZ * offsetZ;
}

export function resamplePath(points: HorizontalPoint[], maximumSpacing: number): HorizontalPoint[] {
  if (points.length < 2 || maximumSpacing <= 0) return points;
  const sampled = [points[0]];
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const steps = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.z - start.z) / maximumSpacing));
    for (let step = 1; step <= steps; step++) {
      const amount = step / steps;
      sampled.push({
        x: start.x + (end.x - start.x) * amount,
        z: start.z + (end.z - start.z) * amount,
      });
    }
  }
  return sampled;
}

export function clipPolyline(
  points: HorizontalPoint[],
  halfWidth: number,
  halfDepth: number,
): HorizontalPoint[][] {
  const paths: HorizontalPoint[][] = [];
  let current: HorizontalPoint[] | undefined;
  for (let index = 1; index < points.length; index++) {
    const segment = clipSegment(points[index - 1], points[index], halfWidth, halfDepth);
    if (!segment) {
      current = undefined;
      continue;
    }
    if (!current || !sameHorizontalPoint(current[current.length - 1], segment[0])) {
      current = [segment[0], segment[1]];
      paths.push(current);
    } else {
      current.push(segment[1]);
    }
  }
  return paths;
}

function clipSegment(
  start: HorizontalPoint,
  end: HorizontalPoint,
  halfWidth: number,
  halfDepth: number,
): [HorizontalPoint, HorizontalPoint] | undefined {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  let minimum = 0;
  let maximum = 1;
  const tests: Array<[number, number]> = [
    [-dx, start.x + halfWidth],
    [dx, halfWidth - start.x],
    [-dz, start.z + halfDepth],
    [dz, halfDepth - start.z],
  ];
  for (const [direction, distance] of tests) {
    if (direction === 0) {
      if (distance < 0) return undefined;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return undefined;
  }
  return [
    { x: start.x + minimum * dx, z: start.z + minimum * dz },
    { x: start.x + maximum * dx, z: start.z + maximum * dz },
  ];
}

function sameHorizontalPoint(a: HorizontalPoint, b: HorizontalPoint): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
}

/** Combines mapped surfaces without coupling vegetation placement to their source. */
export function combineHorizontalExclusionMasks(
  masks: readonly HorizontalExclusionMask[],
): HorizontalExclusionMask {
  return {
    intersects: (x, z, radius) => masks.some((mask) => mask.intersects(x, z, radius)),
  };
}

/** Excludes circular object footprints from filled polygons while preserving holes. */
export class PolygonExclusionMask implements HorizontalExclusionMask {
  private readonly cells = new Map<string, HorizontalPolygon[]>();
  private readonly cellSize: number;

  constructor(polygons: readonly HorizontalPolygon[], cellSize = 20) {
    this.cellSize = cellSize;
    for (const polygon of polygons) {
      if (polygon.outer.length === 0) continue;
      const xs = polygon.outer.map((point) => point.x);
      const zs = polygon.outer.map((point) => point.z);
      const minimumX = Math.floor(Math.min(...xs) / cellSize);
      const maximumX = Math.floor(Math.max(...xs) / cellSize);
      const minimumZ = Math.floor(Math.min(...zs) / cellSize);
      const maximumZ = Math.floor(Math.max(...zs) / cellSize);
      for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ++) {
        for (let cellX = minimumX; cellX <= maximumX; cellX++) {
          const key = `${cellX},${cellZ}`;
          const cell = this.cells.get(key);
          if (cell) cell.push(polygon);
          else this.cells.set(key, [polygon]);
        }
      }
    }
  }

  intersects(x: number, z: number, radius: number): boolean {
    const radiusSquared = radius * radius;
    const candidates = new Set<HorizontalPolygon>();
    const minimumX = Math.floor((x - radius) / this.cellSize);
    const maximumX = Math.floor((x + radius) / this.cellSize);
    const minimumZ = Math.floor((z - radius) / this.cellSize);
    const maximumZ = Math.floor((z + radius) / this.cellSize);
    for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ++) {
      for (let cellX = minimumX; cellX <= maximumX; cellX++) {
        for (const polygon of this.cells.get(`${cellX},${cellZ}`) ?? []) {
          candidates.add(polygon);
        }
      }
    }
    for (const polygon of candidates) {
      if (pointInHorizontalRing(x, z, polygon.outer) &&
          !(polygon.holes ?? []).some((hole) => pointInHorizontalRing(x, z, hole))) {
        return true;
      }
      const rings = [polygon.outer, ...(polygon.holes ?? [])];
      if (rings.some((ring) => horizontalRingDistanceSquared(x, z, ring) <= radiusSquared)) {
        return true;
      }
    }
    return false;
  }
}

function pointInHorizontalRing(
  x: number,
  z: number,
  ring: ReadonlyArray<{ x: number; z: number }>,
): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index];
    const b = ring[previous];
    if ((a.z > z) !== (b.z > z) &&
        x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function horizontalRingDistanceSquared(
  x: number,
  z: number,
  ring: ReadonlyArray<{ x: number; z: number }>,
): number {
  let closest = Infinity;
  for (let index = 0; index < ring.length; index++) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    const amount = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - start.x) * dx + (z - start.z) * dz) / lengthSquared));
    const offsetX = x - (start.x + dx * amount);
    const offsetZ = z - (start.z + dz * amount);
    closest = Math.min(closest, offsetX * offsetX + offsetZ * offsetZ);
  }
  return closest;
}

const mercatorY = (latitude: number): number =>
  Math.asinh(Math.tan((latitude * Math.PI) / 180));

export function lonLatToScene(
  longitude: number,
  latitude: number,
  bounds: GeographicBounds,
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
  bounds: GeographicBounds,
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

/**
 * Ground metres for a location, for fields that must stay continuous across
 * streamed tiles. Scene coordinates restart at the centre of every tile, so
 * noise sampled in them repeats per tile and can never carry a feature larger
 * than one. A flat approximation around the sample latitude is exact enough
 * over the few kilometres such a field spans, and is continuous everywhere
 * except the antimeridian.
 */
export function groundMetersAt(
  longitude: number,
  latitude: number,
): { x: number; y: number } {
  const metersPerDegreeLatitude = 111_320;
  return {
    x: longitude * metersPerDegreeLatitude * Math.cos(latitude * Math.PI / 180),
    y: latitude * metersPerDegreeLatitude,
  };
}

/**
 * Positions a locally centered geographic mesh inside a stable scene frame.
 * Adding this offset to any target-local coordinate produces the same scene
 * coordinate as projecting that longitude/latitude directly in the frame.
 */
export function geographicFrameOffset(
  frame: SceneGeographicFrame,
  target: SceneGeographicFrame,
): { x: number; z: number } {
  const center = sceneToLonLat(
    0,
    0,
    target.bounds,
    target.meshWidth,
    target.meshDepth,
  );
  return lonLatToScene(
    center.lon,
    center.lat,
    frame.bounds,
    frame.meshWidth,
    frame.meshDepth,
  );
}

export function sampleElevation(
  terrain: ElevationGrid,
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
  terrain: ElevationGrid,
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
