import type { LayoutRoom, Opening2D, Point2D, Polygon2D, PolygonLayout } from "./FloorPlan";
import { planningFrameForPolygon, pointFromPlanningFrame, pointInPlanningFrame } from "./PlanningFrame.mjs";
import { decomposeToConvexPolygons } from "./PolygonDecomposition.mjs";
type CartesianAxis = "x" | "y";

interface PolygonSplit {
  first: Point2D[];
  second: Point2D[];
  wall: readonly [Point2D, Point2D];
  axis: CartesianAxis;
  coordinate: number;
}

export const MINIMUM_ROOM_AREA_SQUARE_METERS = 10;
/** A 10 m² strip is not a usable room; keep a practical clear dimension too. */
export const MINIMUM_ROOM_CLEAR_WIDTH_METERS = 2.4;

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
  const frame = planningFrameForPolygon(input.apartmentPolygon.outer);
  const toLocal = (point: Point2D): Point2D => pointInPlanningFrame(point, frame);
  const toWorld = (point: Point2D): Point2D => pointFromPlanningFrame(point, frame);
  const layout = planApartmentLayoutInLocalFrame({
    apartmentPolygon: { outer: input.apartmentPolygon.outer.map(toLocal) },
    openings: input.openings?.map((opening) => ({
      ...opening,
      start: toLocal(opening.start),
      end: toLocal(opening.end),
    })),
  });
  return {
    boundary: { outer: layout.boundary.outer.map(toWorld) },
    rooms: layout.rooms.map((room) => ({ ...room, polygon: { outer: room.polygon.outer.map(toWorld) } })),
    openings: layout.openings?.map((opening) => ({
      ...opening,
      start: toWorld(opening.start),
      end: toWorld(opening.end),
    })),
  };
}

function planApartmentLayoutInLocalFrame(input: ApartmentPlannerInput): ApartmentLayout {
  const boundary = validatedConvexPolygon(input.apartmentPolygon, "apartment");
  if (polygonArea(boundary.outer) < MINIMUM_ROOM_AREA_SQUARE_METERS - 1e-7) {
    throw new Error(`An apartment needs at least ${MINIMUM_ROOM_AREA_SQUARE_METERS} square meters.`);
  }
  const openings = input.openings ?? [];
  const pieces = mergeUndersizedConvexPieces(decomposeToConvexPolygons(boundary.outer));
  // Concave decomposition is a planning aid, not a license to turn a narrow
  // leftover wedge into a room. If no convex neighbour can absorb every
  // fragment, retain the shell rather than emit a substandard room.
  const polygons = pieces && pieces.every(isUsableRoom)
    ? pieces.flatMap((polygon) => subdivideRooms(polygon, openings))
    : [[...boundary.outer]];
  const rooms: LayoutRoom<ApartmentRoomType>[] = polygons.map((outer, index) => ({
    id: `room-${index + 1}`,
    type: "room",
    polygon: { outer },
    label: `Room ${index + 1}`,
  }));
  return { boundary, rooms, openings: [...openings, ...internalRoomDoors(rooms)] };
}

export const defaultApartmentLayoutPlanner: ApartmentLayoutPlanner = planApartmentLayout;

function internalRoomDoors(rooms: readonly LayoutRoom<ApartmentRoomType>[]): Opening2D[] {
  if (rooms.length < 2) return [];
  const connected = new Set<number>([0]);
  const doors: Opening2D[] = [];
  while (connected.size < rooms.length) {
    let best: { from: number; to: number; segment: readonly [Point2D, Point2D]; length: number } | undefined;
    for (const from of connected) {
      for (let to = 0; to < rooms.length; to++) {
        if (connected.has(to)) continue;
        const segment = sharedSegment(
          rooms[from].polygon.outer,
          rooms[to].polygon.outer,
        );
        if (!segment) continue;
        const length = Math.hypot(segment[1].x - segment[0].x, segment[1].y - segment[0].y);
        if (!best || length > best.length) best = { from, to, segment, length };
      }
    }
    if (!best) break;
    connected.add(best.to);
    const width = Math.min(0.9, Math.max(0.7, best.length - 0.3));
    const center = {
      x: (best.segment[0].x + best.segment[1].x) / 2,
      y: (best.segment[0].y + best.segment[1].y) / 2,
    };
    const direction = {
      x: (best.segment[1].x - best.segment[0].x) / best.length,
      y: (best.segment[1].y - best.segment[0].y) / best.length,
    };
    doors.push({
      id: `room-door-${doors.length + 1}`,
      type: "door",
      start: { x: center.x - direction.x * width / 2, y: center.y - direction.y * width / 2 },
      end: { x: center.x + direction.x * width / 2, y: center.y + direction.y * width / 2 },
    });
  }
  return doors;
}

function sharedSegment(
  first: readonly Point2D[],
  second: readonly Point2D[],
): readonly [Point2D, Point2D] | undefined {
  let longest: readonly [Point2D, Point2D] | undefined;
  let longestLength = 0;
  for (let firstIndex = 0; firstIndex < first.length; firstIndex++) {
    const a = first[firstIndex];
    const b = first[(firstIndex + 1) % first.length];
    for (let secondIndex = 0; secondIndex < second.length; secondIndex++) {
      const c = second[secondIndex];
      const d = second[(secondIndex + 1) % second.length];
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
          !isUsableRoom(split.first) ||
          !isUsableRoom(split.second) ||
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

function isUsableRoom(polygon: readonly Point2D[]): boolean {
  if (polygonArea(polygon) < MINIMUM_ROOM_AREA_SQUARE_METERS - 1e-7) return false;
  const bounds = polygonBounds(polygon);
  return Math.min(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) >=
    MINIMUM_ROOM_CLEAR_WIDTH_METERS - 1e-7;
}

function mergeUndersizedConvexPieces(pieces: readonly Point2D[][]): Point2D[][] | undefined {
  const remaining = pieces.map((piece) => [...piece]);
  for (let attempts = 0; attempts < pieces.length * 2; attempts++) {
    const target = remaining.findIndex((piece) => !isUsableRoom(piece));
    if (target < 0) return remaining;
    let best: { index: number; polygon: Point2D[]; score: number } | undefined;
    for (let index = 0; index < remaining.length; index++) {
      if (index === target) continue;
      const merged = mergeNeighbouringPieces(remaining[target], remaining[index]);
      if (!merged) continue;
      const area = polygonArea(merged);
      const score = (isUsableRoom(merged) ? 1_000_000 : 0) + area;
      if (!best || score > best.score) best = { index, polygon: merged, score };
    }
    if (!best) return undefined;
    const keep = Math.min(target, best.index);
    const remove = Math.max(target, best.index);
    remaining[keep] = best.polygon;
    remaining.splice(remove, 1);
  }
  return remaining.every(isUsableRoom) ? remaining : undefined;
}

function mergeNeighbouringPieces(first: readonly Point2D[], second: readonly Point2D[]): Point2D[] | undefined {
  const edges = new Map<string, { start: Point2D; end: Point2D }>();
  for (const polygon of [first, second]) {
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const reverse = edgeKey(end, start);
      if (edges.has(reverse)) edges.delete(reverse);
      else edges.set(edgeKey(start, end), { start, end });
    }
  }
  if (edges.size >= first.length + second.length) return undefined;
  const remaining = [...edges.values()];
  const firstEdge = remaining.shift();
  if (!firstEdge) return undefined;
  const polygon = [firstEdge.start];
  let end = firstEdge.end;
  while (remaining.length > 0) {
    polygon.push(end);
    const next = remaining.findIndex((edge) => samePoint(edge.start, end));
    if (next < 0) return undefined;
    end = remaining[next].end;
    remaining.splice(next, 1);
  }
  return samePoint(end, polygon[0]) && polygon.length >= 3 ? polygon : undefined;
}

function edgeKey(start: Point2D, end: Point2D): string {
  return `${start.x.toFixed(7)},${start.y.toFixed(7)}>${end.x.toFixed(7)},${end.y.toFixed(7)}`;
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
  return { outer };
}

function overlappingSegment(
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
  const low = Math.max(0, Math.min(project(c), project(d)));
  const high = Math.min(length, Math.max(project(c), project(d)));
  return high - low > 1e-7
    ? [{ x: a.x + dx * low / length, y: a.y + dy * low / length },
      { x: a.x + dx * high / length, y: a.y + dy * high / length }]
    : undefined;
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
  const uniqueValues = [...new Set(values.map((value) => value.toFixed(7)))].map(Number);
  // Concave rooms are split only across a single interior segment. More than
  // two intersections would join disconnected regions in the clip result.
  if (uniqueValues.length !== 2) return undefined;
  const minimum = Math.min(...uniqueValues);
  const maximum = Math.max(...uniqueValues);
  return axis === "x"
    ? [{ x: coordinate, y: minimum }, { x: coordinate, y: maximum }]
    : [{ x: minimum, y: coordinate }, { x: maximum, y: coordinate }];
}

function samePoint(a: Point2D, b: Point2D): boolean {
  return a.x === b.x && a.y === b.y;
}
