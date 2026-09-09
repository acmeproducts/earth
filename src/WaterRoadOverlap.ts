import type { PlanarPoint } from "./PlanarGeometry";
import type { RoadPlan } from "./RoadPlanner";
import { createWaterBuildingOverlapFilter } from "./WaterBuildingOverlap";

interface WaterRoad {
  paths: ReadonlyArray<readonly PlanarPoint[]>;
  appearance: RoadPlan;
}

/** Use actual carriageway widths, without shoulders that may legitimately border water. */
export function createWaterRoadOverlapFilter(
  roads: readonly WaterRoad[],
  metersPerUnit: number,
  cellSize: number,
) {
  const footprints: { outline: PlanarPoint[]; holes: PlanarPoint[][] }[] = [];
  for (const { paths, appearance } of roads) {
    // Grade-separated crossings and explicit fords are compatible with water.
    if (appearance.structure !== "surface" || appearance.layer !== 0) continue;
    const halfWidth = appearance.widthMeters / (2 * metersPerUnit);
    for (const path of paths) {
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length <= 1e-12) continue;
        const dx = -(b.z - a.z) / length * halfWidth;
        const dz = (b.x - a.x) / length * halfWidth;
        footprints.push({ outline: [
          { x: a.x + dx, z: a.z + dz }, { x: b.x + dx, z: b.z + dz },
          { x: b.x - dx, z: b.z - dz }, { x: a.x - dx, z: a.z - dz },
        ], holes: [] });
      }
    }
  }
  // Ignore small shoreline registration errors; reject water substantially on roads.
  return createWaterBuildingOverlapFilter(footprints, cellSize, 0.1);
}
