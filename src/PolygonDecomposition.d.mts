import type { Point2D } from "./FloorPlan";

export function isConvexPolygon(points: readonly Point2D[]): boolean;
/** Uses local-frame orthogonal cuts; keeps unsplittable pieces intact, including concave ones. */
export function decomposeToConvexPolygons(points: readonly Point2D[]): Point2D[][];
export function mergeConvexNeighbours(
  first: readonly Point2D[],
  second: readonly Point2D[],
): { polygon: Point2D[]; sharedLength: number } | undefined;
