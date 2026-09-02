import { sampleElevation } from "./Geo";
import { smoothstep } from "./MathUtils";
import type { RoadStructure } from "./RoadPlanner";
import type { TerrainData } from "./TerrainData";
import type { TerrainModification } from "./TerrainModification";

export interface TerrainRoadPath {
  points: ReadonlyArray<{ x: number; z: number }>;
  widthMeters: number;
  shoulderWidthMeters: number;
  structure: RoadStructure;
}

export interface RoadTerrainOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
}

interface StampingSegment extends TerrainModification {
  start: { x: number; z: number };
  end: { x: number; z: number };
  startElevation: number;
  endElevation: number;
  flatRadius: number;
  outerRadius: number;
  targetElevationAt: (x: number, z: number) => number;
  influenceAt: (x: number, z: number) => number;
}

/** Flattens each road carriageway and eases its shoulder back into the source terrain. */
export async function conformTerrainToRoads(
  terrain: TerrainData,
  paths: readonly TerrainRoadPath[],
  options: RoadTerrainOptions,
  yieldControl?: () => Promise<void>,
): Promise<number> {
  const eligible = paths.filter((path) =>
    path.points.length >= 2 && (path.structure === "surface" || path.structure === "ford")
  );
  if (eligible.length === 0) return 0;

  const originalElevations = terrain.elevations.slice();
  const sampleSpacing = Math.min(
    options.meshWidth / Math.max(1, terrain.width - 1),
    options.meshDepth / Math.max(1, terrain.height - 1),
  );
  const segments: StampingSegment[] = [];
  for (const path of eligible) {
    const sampled = resamplePath(path.points, sampleSpacing);
    const visualRadius = path.widthMeters / options.metersPerUnit / 2;
    // A road can be narrower than one elevation cell. Flatten every grid
    // vertex capable of contributing interpolation beneath the visible road,
    // otherwise an unsampled ridge can still poke through the ribbon.
    const flatRadius = visualRadius + sampleSpacing * Math.SQRT2;
    const outerRadius = flatRadius + path.shoulderWidthMeters / options.metersPerUnit;
    const elevations = sampled.map((point) =>
      sampleElevation(
        terrain,
        point.x,
        point.z,
        options.meshWidth,
        options.meshDepth,
        originalElevations,
      )
    );
    for (let index = 1; index < sampled.length; index++) {
      segments.push({
        start: sampled[index - 1],
        end: sampled[index],
        startElevation: elevations[index - 1],
        endElevation: elevations[index],
        flatRadius,
        outerRadius,
        minimumX: Math.min(sampled[index - 1].x, sampled[index].x) - outerRadius,
        maximumX: Math.max(sampled[index - 1].x, sampled[index].x) + outerRadius,
        minimumZ: Math.min(sampled[index - 1].z, sampled[index].z) - outerRadius,
        maximumZ: Math.max(sampled[index - 1].z, sampled[index].z) + outerRadius,
        targetElevationAt: (x, z) => {
          const closest = closestPointOnSegment(x, z, sampled[index - 1], sampled[index]);
          return elevations[index - 1] + (elevations[index] - elevations[index - 1]) * closest.amount;
        },
        influenceAt: (x, z) => {
          const closest = closestPointOnSegment(x, z, sampled[index - 1], sampled[index]);
          const distance = Math.hypot(x - closest.x, z - closest.z);
          if (distance >= outerRadius) return 0;
          return distance <= flatRadius ? 1 : 1 - smoothstep(flatRadius, outerRadius, distance);
        },
      });
    }
    await yieldControl?.();
  }
  if (segments.length === 0) return 0;

  const cellSize = Math.max(sampleSpacing * 4, 12 / options.metersPerUnit);
  const cells = indexSegments(segments, cellSize);
  let modifiedSamples = 0;
  for (let row = 0; row < terrain.height; row++) {
    const v = row / Math.max(1, terrain.height - 1);
    const z = (0.5 - v) * options.meshDepth;
    for (let column = 0; column < terrain.width; column++) {
      const u = column / Math.max(1, terrain.width - 1);
      const x = (u - 0.5) * options.meshWidth;
      const candidates = cells.get(cellKey(x, z, cellSize));
      if (!candidates) continue;

      let weightedElevation = 0;
      let totalWeight = 0;
      let strongestBlend = 0;
      for (const segment of candidates) {
        const blend = segment.influenceAt(x, z);
        if (blend <= 0) continue;
        const targetElevation = segment.targetElevationAt(x, z);
        weightedElevation += targetElevation * blend;
        totalWeight += blend;
        strongestBlend = Math.max(strongestBlend, blend);
      }
      if (totalWeight <= 0) continue;
      const index = row * terrain.width + column;
      const targetElevation = weightedElevation / totalWeight;
      terrain.elevations[index] = originalElevations[index] +
        (targetElevation - originalElevations[index]) * strongestBlend;
      modifiedSamples++;
    }
    await yieldControl?.();
  }

  terrain.minElevation = Infinity;
  terrain.maxElevation = -Infinity;
  for (const elevation of terrain.elevations) {
    terrain.minElevation = Math.min(terrain.minElevation, elevation);
    terrain.maxElevation = Math.max(terrain.maxElevation, elevation);
  }
  return modifiedSamples;
}

function indexSegments(
  segments: readonly StampingSegment[],
  cellSize: number,
): Map<string, StampingSegment[]> {
  const cells = new Map<string, StampingSegment[]>();
  for (const segment of segments) {
    const minimumX = Math.floor((Math.min(segment.start.x, segment.end.x) - segment.outerRadius) / cellSize);
    const maximumX = Math.floor((Math.max(segment.start.x, segment.end.x) + segment.outerRadius) / cellSize);
    const minimumZ = Math.floor((Math.min(segment.start.z, segment.end.z) - segment.outerRadius) / cellSize);
    const maximumZ = Math.floor((Math.max(segment.start.z, segment.end.z) + segment.outerRadius) / cellSize);
    for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ++) {
      for (let cellX = minimumX; cellX <= maximumX; cellX++) {
        const key = `${cellX},${cellZ}`;
        const cell = cells.get(key);
        if (cell) cell.push(segment);
        else cells.set(key, [segment]);
      }
    }
  }
  return cells;
}

function cellKey(x: number, z: number, cellSize: number): string {
  return `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`;
}

function closestPointOnSegment(
  x: number,
  z: number,
  start: { x: number; z: number },
  end: { x: number; z: number },
): { x: number; z: number; amount: number } {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((x - start.x) * dx + (z - start.z) * dz) / lengthSquared));
  return {
    x: start.x + dx * amount,
    z: start.z + dz * amount,
    amount,
  };
}

function resamplePath(
  points: ReadonlyArray<{ x: number; z: number }>,
  maximumSpacing: number,
): Array<{ x: number; z: number }> {
  if (points.length < 2 || maximumSpacing <= 0) return [...points];
  const sampled = [points[0]];
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(end.x - start.x, end.z - start.z) / maximumSpacing),
    );
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
