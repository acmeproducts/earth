import { sampleElevation } from "./Geo";
import { smoothstep } from "./MathUtils";
import type {
  PlannedBuildingSite,
  PlannedRoadPolygon,
  PlanningPoint,
  RoadAndBuildingPlan,
} from "./RoadAndBuildingPlanner";
import type { TerrainData } from "./TerrainData";

export interface PlannedFeatureTerrainOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
}

interface RoadGrade {
  road: PlannedRoadPolygon;
  startElevation: number;
  endElevation: number;
  bounds: Bounds;
}

interface BuildingGrade {
  site: PlannedBuildingSite;
  elevation: number;
  bounds: Bounds;
}

interface Bounds {
  minimumX: number;
  maximumX: number;
  minimumZ: number;
  maximumZ: number;
}

/** Applies one coordinated terrain pass from the shared construction plan. */
export async function conformTerrainToPlannedFeatures(
  terrain: TerrainData,
  plan: RoadAndBuildingPlan,
  options: PlannedFeatureTerrainOptions,
  yieldControl?: () => Promise<void>,
): Promise<number> {
  if (plan.roads.length === 0 && plan.buildingSites.length === 0) return 0;
  const original = terrain.elevations.slice();
  const sampleSpacing = Math.max(
    options.meshWidth / Math.max(1, terrain.width - 1),
    options.meshDepth / Math.max(1, terrain.height - 1),
  );
  const rasterMargin = sampleSpacing * Math.SQRT2;
  const roadBlendWidth = Math.max(1.5 * sampleSpacing, 2 / options.metersPerUnit);
  const buildingFlatMargin = Math.max(sampleSpacing * 1.25, 1 / options.metersPerUnit);
  const buildingBlendWidth = Math.max(sampleSpacing * 1.5, 3 / options.metersPerUnit);

  const roads: RoadGrade[] = plan.roads
    .filter((road) => road.structure === "surface" || road.structure === "ford")
    .map((road) => ({
      road,
      startElevation: elevationAt(terrain, road.centerline[0], options, original),
      endElevation: elevationAt(terrain, road.centerline[1], options, original),
      bounds: polygonBounds(road.outline),
    }));
  const buildings: BuildingGrade[] = [];
  for (const site of plan.buildingSites) {
    const points = [polygonCentroid(site.outline), ...site.outline]
      .filter((point) => withinTerrain(point, options));
    const elevations = points
      .map((point) => elevationAt(terrain, point, options, original))
      .sort((a, b) => a - b);
    if (elevations.length > 0 && elevations[Math.floor(elevations.length / 2)] > 0) {
      buildings.push({
        site,
        elevation: elevations[Math.floor(elevations.length / 2)],
        bounds: polygonBounds(site.outline),
      });
    }
    await yieldControl?.();
  }

  const cellSize = Math.max(sampleSpacing * 4, 12 / options.metersPerUnit);
  const roadCells = indexGrades(roads, cellSize, rasterMargin + roadBlendWidth);
  const buildingCells = indexGrades(
    buildings,
    cellSize,
    buildingFlatMargin + buildingBlendWidth,
  );
  let modified = 0;
  for (let row = 0; row < terrain.height; row++) {
    const z = (0.5 - row / Math.max(1, terrain.height - 1)) * options.meshDepth;
    for (let column = 0; column < terrain.width; column++) {
      const x = (column / Math.max(1, terrain.width - 1) - 0.5) * options.meshWidth;
      const key = cellKey(x, z, cellSize);
      const roadTarget = strongestRoadTarget(
        x,
        z,
        roadCells.get(key) ?? [],
        rasterMargin,
        roadBlendWidth,
      );
      const buildingTarget = strongestBuildingTarget(
        x,
        z,
        buildingCells.get(key) ?? [],
        buildingFlatMargin,
        buildingBlendWidth,
      );
      if (!roadTarget && !buildingTarget) continue;

      // A carriageway owns shared road/building apron samples. Because both
      // targets were derived from the same untouched raster, this decision is
      // stable and cannot re-introduce height in a later stamping pass.
      const selected = roadTarget?.inside && !buildingTarget?.inside
        ? roadTarget
        : buildingTarget?.inside && !roadTarget?.inside
          ? buildingTarget
          : roadTarget?.inside && buildingTarget?.inside
            ? roadTarget
            : buildingTarget && (!roadTarget || buildingTarget.weight > roadTarget.weight)
              ? buildingTarget
              : roadTarget!;
      const index = row * terrain.width + column;
      terrain.elevations[index] = original[index] +
        (selected.elevation - original[index]) * selected.weight;
      modified++;
    }
    await yieldControl?.();
  }
  updateElevationRange(terrain);
  return modified;
}

function strongestRoadTarget(
  x: number,
  z: number,
  roads: readonly RoadGrade[],
  flatMargin: number,
  blendWidth: number,
): { elevation: number; weight: number; inside: boolean } | undefined {
  let result: { elevation: number; weight: number; distance: number; inside: boolean } | undefined;
  for (const grade of roads) {
    const inside = pointInPolygon(x, z, grade.road.outline);
    const distance = inside
      ? 0
      : distanceToPolygon(x, z, grade.road.outline);
    const outer = flatMargin + blendWidth;
    if (distance >= outer) continue;
    const weight = distance <= flatMargin ? 1 : 1 - smoothstep(flatMargin, outer, distance);
    if (result && (weight < result.weight || (weight === result.weight && distance >= result.distance))) continue;
    const closest = closestPointOnSegment(x, z, grade.road.centerline[0], grade.road.centerline[1]);
    result = {
      elevation: grade.startElevation + (grade.endElevation - grade.startElevation) * closest.amount,
      weight,
      distance,
      inside,
    };
  }
  return result;
}

function strongestBuildingTarget(
  x: number,
  z: number,
  buildings: readonly BuildingGrade[],
  flatMargin: number,
  blendWidth: number,
): { elevation: number; weight: number; inside: boolean } | undefined {
  let weightedElevation = 0;
  let totalWeight = 0;
  let strongest = 0;
  let insideAny = false;
  const outer = flatMargin + blendWidth;
  for (const grade of buildings) {
    const inside = pointInPolygon(x, z, grade.site.outline);
    const distance = inside
      ? 0
      : distanceToPolygon(x, z, grade.site.outline);
    if (distance >= outer) continue;
    const weight = distance <= flatMargin ? 1 : 1 - smoothstep(flatMargin, outer, distance);
    weightedElevation += grade.elevation * weight;
    totalWeight += weight;
    strongest = Math.max(strongest, weight);
    insideAny ||= inside;
  }
  return totalWeight > 0
    ? { elevation: weightedElevation / totalWeight, weight: strongest, inside: insideAny }
    : undefined;
}

function elevationAt(
  terrain: TerrainData,
  point: PlanningPoint,
  options: PlannedFeatureTerrainOptions,
  elevations: Float32Array,
): number {
  return sampleElevation(
    terrain,
    point.x,
    point.z,
    options.meshWidth,
    options.meshDepth,
    elevations,
  );
}

function closestPointOnSegment(
  x: number,
  z: number,
  start: PlanningPoint,
  end: PlanningPoint,
): { amount: number } {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  return {
    amount: lengthSquared <= 1e-12
      ? 0
      : Math.max(0, Math.min(1, ((x - start.x) * dx + (z - start.z) * dz) / lengthSquared)),
  };
}

function pointInPolygon(x: number, z: number, points: readonly PlanningPoint[]): boolean {
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

function distanceToPolygon(x: number, z: number, points: readonly PlanningPoint[]): number {
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
    distance = Math.min(distance, Math.hypot(x - start.x - dx * amount, z - start.z - dz * amount));
  }
  return distance;
}

function polygonCentroid(points: readonly PlanningPoint[]): PlanningPoint {
  const sum = points.reduce((value, point) => ({ x: value.x + point.x, z: value.z + point.z }), { x: 0, z: 0 });
  return { x: sum.x / Math.max(1, points.length), z: sum.z / Math.max(1, points.length) };
}

function polygonBounds(points: readonly PlanningPoint[]): Bounds {
  return points.reduce((bounds, point) => ({
    minimumX: Math.min(bounds.minimumX, point.x),
    maximumX: Math.max(bounds.maximumX, point.x),
    minimumZ: Math.min(bounds.minimumZ, point.z),
    maximumZ: Math.max(bounds.maximumZ, point.z),
  }), { minimumX: Infinity, maximumX: -Infinity, minimumZ: Infinity, maximumZ: -Infinity });
}

function indexGrades<T extends { bounds: Bounds }>(
  grades: readonly T[],
  cellSize: number,
  margin: number,
): Map<string, T[]> {
  const cells = new Map<string, T[]>();
  for (const grade of grades) {
    const minimumX = Math.floor((grade.bounds.minimumX - margin) / cellSize);
    const maximumX = Math.floor((grade.bounds.maximumX + margin) / cellSize);
    const minimumZ = Math.floor((grade.bounds.minimumZ - margin) / cellSize);
    const maximumZ = Math.floor((grade.bounds.maximumZ + margin) / cellSize);
    for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ++) {
      for (let cellX = minimumX; cellX <= maximumX; cellX++) {
        const key = `${cellX},${cellZ}`;
        const cell = cells.get(key);
        if (cell) cell.push(grade);
        else cells.set(key, [grade]);
      }
    }
  }
  return cells;
}

function cellKey(x: number, z: number, cellSize: number): string {
  return `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`;
}

function withinTerrain(point: PlanningPoint, options: PlannedFeatureTerrainOptions): boolean {
  return Math.abs(point.x) <= options.meshWidth / 2 && Math.abs(point.z) <= options.meshDepth / 2;
}

function updateElevationRange(terrain: TerrainData): void {
  terrain.minElevation = Infinity;
  terrain.maxElevation = -Infinity;
  for (const elevation of terrain.elevations) {
    terrain.minElevation = Math.min(terrain.minElevation, elevation);
    terrain.maxElevation = Math.max(terrain.maxElevation, elevation);
  }
}
