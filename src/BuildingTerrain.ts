import { sampleElevation } from "./Geo";
import { smoothstep } from "./MathUtils";
import type { TerrainData } from "./TerrainData";
import type { TerrainModification } from "./TerrainModification";

export interface TerrainBuildingFootprint {
  outline: ReadonlyArray<{ x: number; z: number }>;
}

export interface BuildingTerrainOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
}

interface FoundationPad extends TerrainModification {
  outline: ReadonlyArray<{ x: number; z: number }>;
  targetElevation: number;
  flatMargin: number;
  outerMargin: number;
  minimumX: number;
  maximumX: number;
  minimumZ: number;
  maximumZ: number;
  targetElevationAt: (x: number, z: number) => number;
  influenceAt: (x: number, z: number) => number;
}

/** Levels building sites and eases each foundation apron into the surrounding terrain. */
export async function conformTerrainToBuildings(
  terrain: TerrainData,
  footprints: readonly TerrainBuildingFootprint[],
  options: BuildingTerrainOptions,
  yieldControl?: () => Promise<void>,
): Promise<number> {
  const originalElevations = terrain.elevations.slice();
  const sampleSpacing = Math.max(
    options.meshWidth / Math.max(1, terrain.width - 1),
    options.meshDepth / Math.max(1, terrain.height - 1),
  );
  const flatMargin = Math.max(1 / options.metersPerUnit, sampleSpacing * 1.25);
  const blendWidth = Math.max(3 / options.metersPerUnit, sampleSpacing * 1.5);
  const pads: FoundationPad[] = [];

  for (const footprint of footprints) {
    const outline = withoutClosingPoint(footprint.outline);
    if (outline.length < 3) continue;
    const samples = [polygonCentroid(outline), ...outline]
      .filter((point) => isWithinTerrain(point, options))
      .map((point) => sampleElevation(
        terrain,
        point.x,
        point.z,
        options.meshWidth,
        options.meshDepth,
        originalElevations,
      ))
      .sort((a, b) => a - b);
    if (samples.length === 0 || samples[Math.floor(samples.length / 2)] <= 0) continue;
    const bounds = polygonBounds(outline);
    const outerMargin = flatMargin + blendWidth;
    pads.push({
      outline,
      targetElevation: samples[Math.floor(samples.length / 2)],
      flatMargin,
      outerMargin,
      minimumX: bounds.minimumX - outerMargin,
      maximumX: bounds.maximumX + outerMargin,
      minimumZ: bounds.minimumZ - outerMargin,
      maximumZ: bounds.maximumZ + outerMargin,
      targetElevationAt: () => samples[Math.floor(samples.length / 2)],
      influenceAt: (x, z) => {
        const distance = pointInPolygon(x, z, outline) ? 0 : distanceToPolygon(x, z, outline);
        if (distance >= outerMargin) return 0;
        return distance <= flatMargin ? 1 : 1 - smoothstep(flatMargin, outerMargin, distance);
      },
    });
    await yieldControl?.();
  }
  if (pads.length === 0) return 0;

  const weightedTargets = new Float64Array(terrain.elevations.length);
  const totalWeights = new Float32Array(terrain.elevations.length);
  const strongestBlends = new Float32Array(terrain.elevations.length);
  for (const pad of pads) {
    const columns = gridRange(
      pad.minimumX,
      pad.maximumX,
      options.meshWidth,
      terrain.width,
      false,
    );
    const rows = gridRange(
      pad.minimumZ,
      pad.maximumZ,
      options.meshDepth,
      terrain.height,
      true,
    );
    for (let row = rows.minimum; row <= rows.maximum; row++) {
      const z = (0.5 - row / Math.max(1, terrain.height - 1)) * options.meshDepth;
      for (let column = columns.minimum; column <= columns.maximum; column++) {
        const x = (column / Math.max(1, terrain.width - 1) - 0.5) * options.meshWidth;
        const blend = pad.influenceAt(x, z);
        if (blend <= 0) continue;
        const index = row * terrain.width + column;
        weightedTargets[index] += pad.targetElevationAt(x, z) * blend;
        totalWeights[index] += blend;
        strongestBlends[index] = Math.max(strongestBlends[index], blend);
      }
    }
    await yieldControl?.();
  }

  let modifiedSamples = 0;
  for (let index = 0; index < terrain.elevations.length; index++) {
    if (totalWeights[index] <= 0) continue;
    const target = weightedTargets[index] / totalWeights[index];
    terrain.elevations[index] = originalElevations[index] +
      (target - originalElevations[index]) * strongestBlends[index];
    modifiedSamples++;
  }
  updateElevationRange(terrain);
  return modifiedSamples;
}

function withoutClosingPoint(
  points: ReadonlyArray<{ x: number; z: number }>,
): ReadonlyArray<{ x: number; z: number }> {
  if (points.length < 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  return Math.hypot(first.x - last.x, first.z - last.z) < 1e-8
    ? points.slice(0, -1)
    : points;
}

function isWithinTerrain(
  point: { x: number; z: number },
  options: BuildingTerrainOptions,
): boolean {
  return Math.abs(point.x) <= options.meshWidth / 2 &&
    Math.abs(point.z) <= options.meshDepth / 2;
}

function gridRange(
  minimum: number,
  maximum: number,
  size: number,
  count: number,
  reversed: boolean,
): { minimum: number; maximum: number } {
  const toIndex = (coordinate: number): number => {
    const ratio = reversed ? 0.5 - coordinate / size : coordinate / size + 0.5;
    return ratio * Math.max(1, count - 1);
  };
  const a = toIndex(minimum);
  const b = toIndex(maximum);
  return {
    minimum: Math.max(0, Math.floor(Math.min(a, b))),
    maximum: Math.min(count - 1, Math.ceil(Math.max(a, b))),
  };
}

function pointInPolygon(
  x: number,
  z: number,
  points: ReadonlyArray<{ x: number; z: number }>,
): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index];
    const b = points[previous];
    if ((a.z > z) !== (b.z > z) &&
        x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToPolygon(
  x: number,
  z: number,
  points: ReadonlyArray<{ x: number; z: number }>,
): number {
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
    distance = Math.min(
      distance,
      Math.hypot(x - (start.x + dx * amount), z - (start.z + dz * amount)),
    );
  }
  return distance;
}

function polygonCentroid(
  points: ReadonlyArray<{ x: number; z: number }>,
): { x: number; z: number } {
  const total = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }),
    { x: 0, z: 0 },
  );
  return { x: total.x / points.length, z: total.z / points.length };
}

function polygonBounds(points: ReadonlyArray<{ x: number; z: number }>): {
  minimumX: number;
  maximumX: number;
  minimumZ: number;
  maximumZ: number;
} {
  return points.reduce((bounds, point) => ({
    minimumX: Math.min(bounds.minimumX, point.x),
    maximumX: Math.max(bounds.maximumX, point.x),
    minimumZ: Math.min(bounds.minimumZ, point.z),
    maximumZ: Math.max(bounds.maximumZ, point.z),
  }), { minimumX: Infinity, maximumX: -Infinity, minimumZ: Infinity, maximumZ: -Infinity });
}

function updateElevationRange(terrain: TerrainData): void {
  terrain.minElevation = Infinity;
  terrain.maxElevation = -Infinity;
  for (const elevation of terrain.elevations) {
    terrain.minElevation = Math.min(terrain.minElevation, elevation);
    terrain.maxElevation = Math.max(terrain.maxElevation, elevation);
  }
}
