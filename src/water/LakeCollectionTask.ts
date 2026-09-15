import { clipToBounds, pointInRing, type PlanarBounds } from "../core/PlanarGeometry";
import type { TerrainLakeSource } from "../terrain/TerrainLakePolygons";
import { createWaterBuildingOverlapFilter, type Footprint } from "./WaterBuildingOverlap";
import { createWaterRoadOverlapFilter, type WaterRoad } from "./WaterRoadOverlap";

export interface LakeCandidate {
  water: TerrainLakeSource;
  clipped: TerrainLakeSource;
}

export interface LakeCollectionInput {
  candidates: readonly LakeCandidate[];
  buildings: readonly Footprint[];
  roads: readonly WaterRoad[];
  metersPerUnit: number;
  cellSize: number;
}

/** Cull before constructing obstacle indexes, but retain full rings for overlap tests. */
export function prepareLakeCandidate(water: TerrainLakeSource, bounds: PlanarBounds): LakeCandidate | undefined {
  const outline = clipToBounds(water.outline, bounds);
  if (outline.length < 3) return undefined;
  const holes = water.holes.map((ring) => clipToBounds(ring, bounds))
    .filter((ring) => ring.length >= 3 && pointInRing(ring[0], outline));
  return { water, clipped: { sourceId: water.sourceId, outline, holes } };
}

export function collectPreparedLakePolygons(input: LakeCollectionInput): TerrainLakeSource[] {
  if (!input.candidates.length) return [];
  const overlapsBuildings = createWaterBuildingOverlapFilter(input.buildings, input.cellSize, 0.15);
  const overlapsRoads = createWaterRoadOverlapFilter(input.roads, input.metersPerUnit, input.cellSize);
  return input.candidates.filter(({ water }) => !overlapsBuildings(water) && !overlapsRoads(water))
    .map(({ clipped }) => clipped);
}

export function runLakeCollectionTask(input: LakeCollectionInput) {
  const startTimeMilliseconds = performance.now();
  const lakes = collectPreparedLakePolygons(input);
  return { lakes, timeOrigin: performance.timeOrigin, timings: [{
    stage: "lake polygon overlap filtering", startTimeMilliseconds,
    durationMilliseconds: performance.now() - startTimeMilliseconds,
  }] };
}

export type LakeCollectionOutput = ReturnType<typeof runLakeCollectionTask>;
