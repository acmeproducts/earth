import type { Point2D } from "./FloorPlan";

export interface PlanningFrame2D {
  origin: Point2D;
  xAxis: Point2D;
  yAxis: Point2D;
}

export function planningFrameForPolygon(points: readonly Point2D[]): PlanningFrame2D;
export function pointInPlanningFrame(point: Point2D, frame: PlanningFrame2D): Point2D;
export function pointFromPlanningFrame(point: Point2D, frame: PlanningFrame2D): Point2D;
