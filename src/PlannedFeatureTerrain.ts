import { sampleElevation } from "./Geo";
import { smoothstep } from "./MathUtils";
import {
  averagePoint,
  distanceToRing,
  PlanarCellIndex,
  pointBounds,
  pointInRing,
  type PlanarPoint,
} from "./PlanarGeometry";
import { roadGradeAmount } from "./RoadAndBuildingPlanner";
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
  /** Stable pad height shared by every tile touched by one building. */
  sharedBuildingElevations?: Map<string, number>;
}

interface RoadGrade {
  road: PlannedRoadPolygon;
  startElevation: number;
  endElevation: number;
}

interface BuildingGrade {
  site: PlannedBuildingSite;
  elevation: number;
}

// Elevations are in metres, independent of the scene scale. Roads may smooth
// small irregularities, but must not cut a straight ramp through an entire hill.
const MAX_ROAD_EARTHWORK_METERS = 1;

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
    }));
  const buildings: BuildingGrade[] = [];
  for (const site of plan.buildingSites) {
    const points = [averagePoint(site.outline), ...site.outline]
      .filter((point) => withinTerrain(point, options));
    const elevations = points
      .map((point) => elevationAt(terrain, point, options, original))
      .sort((a, b) => a - b);
    const sampledElevation = elevations[Math.floor(elevations.length / 2)];
    if (elevations.length > 0 && sampledElevation > 0) {
      let elevation = options.sharedBuildingElevations?.get(site.sourceId);
      if (elevation === undefined) {
        elevation = sampledElevation;
        options.sharedBuildingElevations?.set(site.sourceId, elevation);
      }
      buildings.push({
        site,
        elevation,
      });
    }
    await yieldControl?.();
  }

  const cellSize = Math.max(sampleSpacing * 4, 12 / options.metersPerUnit);
  const roadCells = new PlanarCellIndex<RoadGrade>(cellSize);
  for (const grade of roads) {
    roadCells.add(grade, pointBounds(grade.road.outline), rasterMargin + roadBlendWidth);
  }
  const buildingCells = new PlanarCellIndex<BuildingGrade>(cellSize);
  for (const grade of buildings) {
    buildingCells.add(grade, pointBounds(grade.site.outline), buildingFlatMargin + buildingBlendWidth);
  }
  let modified = 0;
  for (let row = 0; row < terrain.height; row++) {
    const z = (0.5 - row / Math.max(1, terrain.height - 1)) * options.meshDepth;
    for (let column = 0; column < terrain.width; column++) {
      const x = (column / Math.max(1, terrain.width - 1) - 0.5) * options.meshWidth;
      const sample = { x, z };
      const roadTarget = strongestRoadTarget(
        sample,
        roadCells.queryPoint(sample),
        rasterMargin,
        roadBlendWidth,
      );
      const buildingTarget = strongestBuildingTarget(
        sample,
        buildingCells.queryPoint(sample),
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
      const delta = selected.elevation - original[index];
      const earthwork = selected === roadTarget
        ? Math.max(-MAX_ROAD_EARTHWORK_METERS, Math.min(MAX_ROAD_EARTHWORK_METERS, delta))
        : delta;
      terrain.elevations[index] = original[index] +
        earthwork * selected.weight;
      modified++;
    }
    await yieldControl?.();
  }
  updateElevationRange(terrain);
  return modified;
}

function strongestRoadTarget(
  sample: PlanarPoint,
  roads: readonly RoadGrade[],
  flatMargin: number,
  blendWidth: number,
): { elevation: number; weight: number; inside: boolean } | undefined {
  let result: { elevation: number; weight: number; distance: number; inside: boolean } | undefined;
  for (const grade of roads) {
    const inside = pointInRing(sample, grade.road.outline);
    const distance = inside
      ? 0
      : distanceToRing(sample, grade.road.outline);
    const outer = flatMargin + blendWidth;
    if (distance >= outer) continue;
    const weight = distance <= flatMargin ? 1 : 1 - smoothstep(flatMargin, outer, distance);
    if (result && (weight < result.weight || (weight === result.weight && distance >= result.distance))) continue;
    const amount = roadGradeAmount(grade.road, sample);
    result = {
      elevation: grade.startElevation + (grade.endElevation - grade.startElevation) * amount,
      weight,
      distance,
      inside,
    };
  }
  return result;
}

function strongestBuildingTarget(
  sample: PlanarPoint,
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
    const inside = pointInRing(sample, grade.site.outline);
    const distance = inside
      ? 0
      : distanceToRing(sample, grade.site.outline);
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
