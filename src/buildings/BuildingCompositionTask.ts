import { mergeOverlappingBuildings } from "./CompositeBuildings";
import type { BuildingSource } from "./BuildingPlanner";

export function runBuildingComposition(sources: readonly BuildingSource[]) {
  const startTimeMilliseconds = performance.now();
  const result = mergeOverlappingBuildings(sources);
  return { result, timeOrigin: performance.timeOrigin, timings: [{
    stage: "building footprint composition", startTimeMilliseconds,
    durationMilliseconds: performance.now() - startTimeMilliseconds,
  }] };
}
export type BuildingCompositionOutput = ReturnType<typeof runBuildingComposition>;
