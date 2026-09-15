import {
  planRoadsAndBuildings,
  type PlanningRoadInput,
  type PlanningBuildingInput,
  type PlanningLampInput,
  type RoadAndBuildingPlan,
  type RoadAndBuildingPlanningOptions,
} from "./RoadAndBuildingPlanner";

export interface RoadPlanningInput {
  roads: readonly PlanningRoadInput[];
  buildings: readonly PlanningBuildingInput[];
  options: RoadAndBuildingPlanningOptions;
  lamps?: readonly PlanningLampInput[];
}

export interface RoadPlanningOutput {
  plan: RoadAndBuildingPlan;
  timings: { stage: string; startTimeMilliseconds: number; durationMilliseconds: number }[];
  timeOrigin: number;
}

export function runRoadPlanningTask(input: RoadPlanningInput): RoadPlanningOutput {
  const timings: RoadPlanningOutput["timings"] = [];
  const start = performance.now();
  const plan = planRoadsAndBuildings(input.roads, input.buildings, input.options, input.lamps,
    (stage, operation) => {
      const startTimeMilliseconds = performance.now();
      try {
        return operation();
      } finally {
        timings.push({ stage, startTimeMilliseconds, durationMilliseconds: performance.now() - startTimeMilliseconds });
      }
    });
  timings.push({ stage: "road and building planner", startTimeMilliseconds: start,
    durationMilliseconds: performance.now() - start });
  return { plan, timings, timeOrigin: performance.timeOrigin };
}
