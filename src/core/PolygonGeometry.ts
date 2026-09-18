import { ringEdges } from "./Geometry2D";
import type { Point2D, Polygon2D } from "../buildings/FloorPlan";

export type CartesianAxis = "x" | "y";

export function edgeVector(start: Point2D, end: Point2D) {
  const dx = end.x - start.x, dy = end.y - start.y;
  return { dx, dy, length: Math.hypot(dx, dy) };
}

export interface PolygonSplit {
  first: Point2D[];
  second: Point2D[];
  wall: readonly [Point2D, Point2D];
  axis: CartesianAxis;
  coordinate: number;
}

export function longestSharedSegment(
  first: readonly Point2D[],
  second: readonly Point2D[],
): readonly [Point2D, Point2D] | undefined {
  let longest: readonly [Point2D, Point2D] | undefined;
  let longestLength = 0;
  for (const [a, b] of ringEdges(first)) {
    for (const [c, d] of ringEdges(second)) {
      const candidate = overlappingSegment(a, b, c, d);
      if (!candidate) continue;
      const length = Math.hypot(candidate[1].x - candidate[0].x, candidate[1].y - candidate[0].y);
      if (length > longestLength) {
        longest = candidate;
        longestLength = length;
      }
    }
  }
  return longest;
}

export function splitAtCoordinate(
  points: readonly Point2D[],
  axis: CartesianAxis,
  coordinate: number,
): PolygonSplit | undefined {
  const first = clipPolygonAtAxis(points, axis, coordinate, true);
  const second = clipPolygonAtAxis(points, axis, coordinate, false);
  const wall = cutSegment(points, axis, coordinate);
  if (first.length < 3 || second.length < 3 || !wall) return undefined;
  return { first, second, wall, axis, coordinate };
}

export function splitConvexPolygonEqual(
  points: readonly Point2D[],
  axis: CartesianAxis,
): PolygonSplit | undefined {
  const bounds = polygonBounds(points);
  let low = axis === "x" ? bounds.minX : bounds.minY;
  let high = axis === "x" ? bounds.maxX : bounds.maxY;
  const targetArea = polygonArea(points) / 2;
  for (let iteration = 0; iteration < 48; iteration++) {
    const middle = (low + high) / 2;
    if (polygonArea(clipPolygonAtAxis(points, axis, middle, true)) < targetArea) low = middle;
    else high = middle;
  }
  return splitAtCoordinate(points, axis, (low + high) / 2);
}

export function validatedPlanningPolygon(
  polygon: Polygon2D,
  subject: string,
  planner: "Apartment" | "Building",
): Polygon2D {
  const outer = [...polygon.outer];
  if (outer.length > 1 && samePoint(outer[0], outer[outer.length - 1])) outer.pop();
  if (outer.length < 3 || !outer.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
    throw new Error(`A ${subject} polygon needs at least three finite points.`);
  }
  if (polygon.holes?.length) throw new Error(`${planner} planning does not support polygon holes yet.`);
  if (polygonArea(outer) < 0.01) throw new Error(`${planner} polygon area is too small.`);
  return { outer };
}

export interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function polygonArea(points: readonly Point2D[]): number {
  return Math.abs(points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

export function polygonBounds(points: readonly Point2D[]): Bounds2D {
  return {
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y)),
  };
}

/**
 * Conservative average depth across the planning axes and each wall direction.
 * Unlike bounding-box width, this accounts for empty space beside tapered or
 * concave outlines and for narrow wings running diagonally through the frame.
 */
export function polygonMinimumMeanWidth(points: readonly Point2D[]): number {
  if (points.length < 3) return 0;
  const bounds = polygonBounds(points);
  let longestSpan = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  for (let edge = 0; edge < points.length; edge++) {
    const start = points[edge];
    const end = points[(edge + 1) % points.length];
    const { length } = edgeVector(start, end);
    if (length < 1e-7) continue;
    const dx = (end.x - start.x) / length;
    const dy = (end.y - start.y) / length;
    let minAlong = Infinity, maxAlong = -Infinity;
    let minAcross = Infinity, maxAcross = -Infinity;
    for (const point of points) {
      const x = point.x - start.x, y = point.y - start.y;
      const along = x * dx + y * dy;
      const across = -x * dy + y * dx;
      minAlong = Math.min(minAlong, along);
      maxAlong = Math.max(maxAlong, along);
      minAcross = Math.min(minAcross, across);
      maxAcross = Math.max(maxAcross, across);
    }
    longestSpan = Math.max(longestSpan, maxAlong - minAlong, maxAcross - minAcross);
  }
  return longestSpan > 1e-7 ? polygonArea(points) / longestSpan : 0;
}

export function overlappingSegment(
  a: Point2D,
  b: Point2D,
  c: Point2D,
  d: Point2D,
): readonly [Point2D, Point2D] | undefined {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-7 || Math.abs(dx * (c.y - a.y) - dy * (c.x - a.x)) > 1e-6 ||
      Math.abs(dx * (d.y - a.y) - dy * (d.x - a.x)) > 1e-6) return undefined;
  const project = (point: Point2D): number => ((point.x - a.x) * dx + (point.y - a.y) * dy) / length;
  const minimum = Math.max(0, Math.min(project(c), project(d)));
  const maximum = Math.min(length, Math.max(project(c), project(d)));
  return maximum - minimum > 1e-7
    ? [{ x: a.x + dx * minimum / length, y: a.y + dy * minimum / length },
      { x: a.x + dx * maximum / length, y: a.y + dy * maximum / length }]
    : undefined;
}

export function clipPolygonAtAxis(
  points: readonly Point2D[],
  axis: CartesianAxis,
  coordinate: number,
  keepLower: boolean,
): Point2D[] {
  if (points.length === 0) return [];
  const inside = (point: Point2D): boolean => keepLower
    ? point[axis] <= coordinate
    : point[axis] >= coordinate;
  const output: Point2D[] = [];
  let start = points[points.length - 1];
  for (const end of points) {
    if (inside(end)) {
      if (!inside(start)) output.push(axisIntersection(start, end, axis, coordinate));
      output.push(end);
    } else if (inside(start)) output.push(axisIntersection(start, end, axis, coordinate));
    start = end;
  }
  return output;
}

export function cutSegment(
  points: readonly Point2D[],
  axis: CartesianAxis,
  coordinate: number,
): readonly [Point2D, Point2D] | undefined {
  const values: number[] = [];
  for (let index = 0; index < points.length; index++) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    if (Math.abs(start[axis] - coordinate) < 1e-7) values.push(axis === "x" ? start.y : start.x);
    if ((start[axis] < coordinate && end[axis] > coordinate) ||
        (start[axis] > coordinate && end[axis] < coordinate)) {
      const amount = (coordinate - start[axis]) / (end[axis] - start[axis]);
      values.push(axis === "x"
        ? start.y + (end.y - start.y) * amount
        : start.x + (end.x - start.x) * amount);
    }
  }
  const unique = [...new Set(values.map((value) => value.toFixed(7)))].map(Number);
  if (unique.length !== 2) return undefined;
  const minimum = Math.min(...unique);
  const maximum = Math.max(...unique);
  return axis === "x"
    ? [{ x: coordinate, y: minimum }, { x: coordinate, y: maximum }]
    : [{ x: minimum, y: coordinate }, { x: maximum, y: coordinate }];
}

export function samePoint(a: Point2D, b: Point2D): boolean {
  return Math.abs(a.x - b.x) < 1e-7 && Math.abs(a.y - b.y) < 1e-7;
}

function axisIntersection(
  start: Point2D,
  end: Point2D,
  axis: CartesianAxis,
  coordinate: number,
): Point2D {
  const amount = (coordinate - start[axis]) / (end[axis] - start[axis]);
  return axis === "x"
    ? { x: coordinate, y: start.y + (end.y - start.y) * amount }
    : { x: start.x + (end.x - start.x) * amount, y: coordinate };
}

export function pointOnSegment2D(point: Point2D, start: Point2D, end: Point2D): boolean {
  const cross = (end.x - start.x) * (point.y - start.y) -
    (end.y - start.y) * (point.x - start.x);
  if (Math.abs(cross) > 1e-5) return false;
  return point.x >= Math.min(start.x, end.x) - 1e-5 &&
    point.x <= Math.max(start.x, end.x) + 1e-5 &&
    point.y >= Math.min(start.y, end.y) - 1e-5 &&
    point.y <= Math.max(start.y, end.y) + 1e-5;
}
