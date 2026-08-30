import type { LayoutRoom, Opening2D, Point2D, Polygon2D, PolygonLayout } from "./FloorPlan";
type CartesianAxis = "x" | "y";

interface PolygonSplit {
  first: Point2D[];
  second: Point2D[];
  wall: readonly [Point2D, Point2D];
  axis: CartesianAxis;
  coordinate: number;
}

export const MINIMUM_ROOM_AREA_SQUARE_METERS = 10;

export type ApartmentRoomType = "room";

export interface ApartmentPlannerInput {
  apartmentPolygon: Polygon2D;
  openings?: readonly Opening2D[];
}

export interface ApartmentLayout extends PolygonLayout<ApartmentRoomType> {}

export interface ApartmentLayoutPlanner {
  (input: ApartmentPlannerInput): ApartmentLayout;
}

/** Recursively bisects an apartment into balanced rooms using orthogonal walls. */
export function planApartmentLayout(input: ApartmentPlannerInput): ApartmentLayout {
  const boundary = validatedConvexPolygon(input.apartmentPolygon, "apartment");
  const openings = input.openings ?? [];
  const polygons = subdivideRooms(boundary.outer, openings);
  const rooms: LayoutRoom<ApartmentRoomType>[] = polygons.map((outer, index) => ({
    id: `room-${index + 1}`,
    type: "room",
    polygon: { outer },
    label: `Room ${index + 1}`,
  }));
  return { boundary, rooms, openings };
}

export const defaultApartmentLayoutPlanner: ApartmentLayoutPlanner = planApartmentLayout;

function subdivideRooms(
  polygon: readonly Point2D[],
  openings: readonly Opening2D[],
): Point2D[][] {
  if (polygonArea(polygon) < MINIMUM_ROOM_AREA_SQUARE_METERS * 2 - 1e-7) {
    return [[...polygon]];
  }
  const split = bestSplit(polygon, openings);
  if (!split) return [[...polygon]];
  return [
    ...subdivideRooms(split.first, openings),
    ...subdivideRooms(split.second, openings),
  ];
}

function bestSplit(
  polygon: readonly Point2D[],
  openings: readonly Opening2D[],
): PolygonSplit | undefined {
  const bounds = polygonBounds(polygon);
  const preferredAxis: CartesianAxis = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY
    ? "x"
    : "y";
  const axes: readonly CartesianAxis[] = [preferredAxis, preferredAxis === "x" ? "y" : "x"];
  const offsets = [0, 0.025, -0.025, 0.05, -0.05, 0.1, -0.1, 0.15, -0.15, 0.2, -0.2];
  let best: { split: PolygonSplit; score: number } | undefined;
  axes.forEach((axis, axisIndex) => {
    const equal = splitConvexPolygonEqual(polygon, axis);
    if (!equal) return;
    const span = axis === "x" ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY;
    for (const offset of offsets) {
      const split = splitAtCoordinate(polygon, axis, equal.coordinate + span * offset);
      if (!split ||
          polygonArea(split.first) < MINIMUM_ROOM_AREA_SQUARE_METERS - 1e-7 ||
          polygonArea(split.second) < MINIMUM_ROOM_AREA_SQUARE_METERS - 1e-7 ||
          openings.some((opening) => segmentsIntersect(
            split.wall[0], split.wall[1], opening.start, opening.end,
          ))) {
        continue;
      }
      const firstArea = polygonArea(split.first);
      const secondArea = polygonArea(split.second);
      const imbalance = Math.abs(firstArea - secondArea) / (firstArea + secondArea);
      const aspectPenalty = (Math.max(aspectRatio(split.first), aspectRatio(split.second)) - 1) * 0.25;
      const score = imbalance + aspectPenalty + axisIndex * 0.02;
      if (!best || score < best.score) best = { split, score };
    }
  });
  return best?.split;
}

function aspectRatio(points: readonly Point2D[]): number {
  const bounds = polygonBounds(points);
  const width = Math.max(bounds.maxX - bounds.minX, 1e-7);
  const height = Math.max(bounds.maxY - bounds.minY, 1e-7);
  return Math.max(width / height, height / width);
}

function splitAtCoordinate(
  points: readonly Point2D[],
  axis: CartesianAxis,
  coordinate: number,
): PolygonSplit | undefined {
  const first = clipAtAxis(points, axis, coordinate, true);
  const second = clipAtAxis(points, axis, coordinate, false);
  const wall = cutSegment(points, axis, coordinate);
  if (first.length < 3 || second.length < 3 || !wall) return undefined;
  return { first, second, wall, axis, coordinate };
}

function splitConvexPolygonEqual(
  points: readonly Point2D[],
  axis: CartesianAxis,
): PolygonSplit | undefined {
  const bounds = polygonBounds(points);
  let low = axis === "x" ? bounds.minX : bounds.minY;
  let high = axis === "x" ? bounds.maxX : bounds.maxY;
  const targetArea = polygonArea(points) / 2;
  for (let iteration = 0; iteration < 48; iteration++) {
    const middle = (low + high) / 2;
    if (polygonArea(clipAtAxis(points, axis, middle, true)) < targetArea) low = middle;
    else high = middle;
  }
  return splitAtCoordinate(points, axis, (low + high) / 2);
}

function segmentsIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const epsilon = 1e-7;
  const orientation = (p: Point2D, q: Point2D, r: Point2D): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const onSegment = (p: Point2D, q: Point2D, r: Point2D): boolean =>
    q.x >= Math.min(p.x, r.x) - epsilon && q.x <= Math.max(p.x, r.x) + epsilon &&
    q.y >= Math.min(p.y, r.y) - epsilon && q.y <= Math.max(p.y, r.y) + epsilon;
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  if (((first > epsilon && second < -epsilon) || (first < -epsilon && second > epsilon)) &&
      ((third > epsilon && fourth < -epsilon) || (third < -epsilon && fourth > epsilon))) {
    return true;
  }
  return Math.abs(first) <= epsilon && onSegment(a, c, b) ||
    Math.abs(second) <= epsilon && onSegment(a, d, b) ||
    Math.abs(third) <= epsilon && onSegment(c, a, d) ||
    Math.abs(fourth) <= epsilon && onSegment(c, b, d);
}

function validatedConvexPolygon(polygon: Polygon2D, subject: string): Polygon2D {
  const outer = [...polygon.outer];
  if (outer.length > 1 && samePoint(outer[0], outer[outer.length - 1])) outer.pop();
  if (outer.length < 3 || !outer.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
    throw new Error(`A ${subject} polygon needs at least three finite points.`);
  }
  if (polygon.holes?.length) throw new Error("Apartment planning does not support polygon holes yet.");
  if (polygonArea(outer) < 0.01) throw new Error("Apartment polygon area is too small.");
  if (!isConvex(outer)) throw new Error("Apartment planning currently requires a convex polygon.");
  return { outer };
}

function polygonArea(points: readonly Point2D[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area / 2);
}

function polygonBounds(points: readonly Point2D[]): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function clipAtAxis(
  points: readonly Point2D[],
  axis: CartesianAxis,
  coordinate: number,
  keepLower: boolean,
): Point2D[] {
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

function cutSegment(
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
  if (values.length < 2) return undefined;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return axis === "x"
    ? [{ x: coordinate, y: minimum }, { x: coordinate, y: maximum }]
    : [{ x: minimum, y: coordinate }, { x: maximum, y: coordinate }];
}

function isConvex(points: readonly Point2D[]): boolean {
  let direction = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const c = points[(index + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const nextDirection = Math.sign(cross);
    if (direction !== 0 && direction !== nextDirection) return false;
    direction = nextDirection;
  }
  return true;
}

function samePoint(a: Point2D, b: Point2D): boolean {
  return a.x === b.x && a.y === b.y;
}
