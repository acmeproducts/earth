import type {
  LayoutRoom,
  Opening2D,
  Point2D,
  Polygon2D,
  PolygonLayout,
} from "./FloorPlan";
type CartesianAxis = "x" | "y";

interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PolygonSplit {
  first: Point2D[];
  second: Point2D[];
  wall: readonly [Point2D, Point2D];
  coordinate: number;
}

interface Interval {
  minimum: number;
  maximum: number;
}

interface BuildingEntrance extends Interval {
  side: "lower" | "upper";
}

export const MAXIMUM_APARTMENT_AREA_SQUARE_METERS = 120;

export type BuildingLayoutType = "house" | "apartment-building";
export type BuildingRoomType = "apartment" | "hallway" | "stairs";

export interface BuildingPlannerInput {
  /** A local, Cartesian footprint measured in meters. */
  buildingPolygon: Polygon2D;
  buildingType: BuildingLayoutType;
  openings?: readonly Opening2D[];
}

export interface BuildingLayout extends PolygonLayout<BuildingRoomType> {
  buildingType: BuildingLayoutType;
}

/** Callable contract for alternative building-planning strategies. */
export interface BuildingLayoutPlanner {
  (input: BuildingPlannerInput): BuildingLayout;
}

/**
 * Creates apartment shells. Buildings below the apartment-area threshold stay
 * as one shell; larger buildings receive a central corridor and stair core.
 */
export function planBuildingLayout(input: BuildingPlannerInput): BuildingLayout {
  const boundary = validatedConvexPolygon(input.buildingPolygon, "building");
  const openings = validatedOpenings(input.openings);
  if (polygonArea(boundary.outer) <= MAXIMUM_APARTMENT_AREA_SQUARE_METERS) {
    return {
      buildingType: input.buildingType,
      boundary,
      rooms: [{
        id: "apartment-1",
        type: "apartment",
        polygon: boundary,
        label: "Apartment 1",
      }],
      openings,
    };
  }

  return {
    buildingType: input.buildingType,
    boundary,
    ...apartmentBuildingPlan(boundary, openings),
  };
}

export const defaultBuildingLayoutPlanner: BuildingLayoutPlanner = planBuildingLayout;

function apartmentBuildingPlan(
  boundary: Polygon2D,
  openings: readonly Opening2D[],
): { rooms: LayoutRoom<BuildingRoomType>[]; openings: readonly Opening2D[] } {
  const bounds = polygonBounds(boundary.outer);
  const horizontal = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY;
  const longAxis: CartesianAxis = horizontal ? "x" : "y";
  const shortAxis: CartesianAxis = horizontal ? "y" : "x";
  const longMin = horizontal ? bounds.minX : bounds.minY;
  const longMax = horizontal ? bounds.maxX : bounds.maxY;
  const shortMin = horizontal ? bounds.minY : bounds.minX;
  const shortMax = horizontal ? bounds.maxY : bounds.maxX;
  const longSpan = longMax - longMin;
  const shortSpan = shortMax - shortMin;
  if (longSpan < 8 || shortSpan < 6) {
    throw new Error("A subdivided building footprint must be at least 8 by 6 meters.");
  }

  const hallwayWidth = Math.min(2.4, Math.max(1.5, shortSpan * 0.22));
  const hallwayMin = (shortMin + shortMax - hallwayWidth) / 2;
  const hallwayMax = hallwayMin + hallwayWidth;
  const stairLength = Math.min(4, longSpan * 0.3);
  const entrance = exteriorEntrance(
    horizontal,
    longMin,
    longMax,
    shortMin,
    shortMax,
    openings,
  );
  const stairMin = safeStairMinimum(
    horizontal,
    longMin,
    longMax,
    entrance?.side === "upper" ? hallwayMax : shortMin,
    entrance?.side === "upper" ? shortMax : hallwayMin,
    stairLength,
    entrance,
    openings,
  );
  const stairMax = stairMin + stairLength;
  const rooms: LayoutRoom<BuildingRoomType>[] = [];

  addClippedRoom(rooms, "hallway-1", "hallway", boundary.outer,
    orientedRect(horizontal, longMin, hallwayMin, longMax, hallwayMax), "Hallway");
  if (entrance) {
    addClippedRoom(
      rooms,
      "entrance-lobby",
      "hallway",
      boundary.outer,
      orientedRect(
        horizontal,
        entrance.minimum,
        entrance.side === "lower" ? shortMin : hallwayMax,
        entrance.maximum,
        entrance.side === "lower" ? hallwayMin : shortMax,
      ),
      "Entrance lobby",
    );
  }
  addClippedRoom(rooms, "stairs-1", "stairs", boundary.outer,
    orientedRect(
      horizontal,
      stairMin,
      entrance?.side === "upper" ? hallwayMax : shortMin,
      stairMax,
      entrance?.side === "upper" ? shortMax : hallwayMin,
    ), "Stairs");

  const serviceSide = entrance?.side ?? "lower";
  const oppositeSide = clipPolygonAtAxis(
    boundary.outer,
    shortAxis,
    serviceSide === "lower" ? hallwayMax : hallwayMin,
    serviceSide === "lower" ? false : true,
  );
  const excludedRanges = [
    { minimum: stairMin, maximum: stairMax },
    ...(entrance ? [{ minimum: entrance.minimum, maximum: entrance.maximum }] : []),
  ];
  const serviceApartments = remainingIntervals(longMin, longMax, excludedRanges).map((interval) =>
    clippedToOrientedRectangle(
      boundary.outer,
      orientedRect(
        horizontal,
        interval.minimum,
        serviceSide === "lower" ? shortMin : hallwayMax,
        interval.maximum,
        serviceSide === "lower" ? hallwayMin : shortMax,
      ),
    ));
  const apartmentPolygons = [...serviceApartments, oppositeSide]
    .filter((polygon) => polygonArea(polygon) > 0.01)
    .flatMap((polygon) => partitionToMaximumArea(polygon, longAxis, openings));
  apartmentPolygons.forEach((outer, index) => rooms.push({
    id: `apartment-${index + 1}`,
    type: "apartment",
    polygon: { outer },
    label: `Apartment ${index + 1}`,
  }));
  return {
    rooms,
    openings: [...openings, ...apartmentEntranceDoors(rooms)],
  };
}

function partitionToMaximumArea(
  polygon: readonly Point2D[],
  preferredAxis: CartesianAxis,
  openings: readonly Opening2D[],
): Point2D[][] {
  if (polygonArea(polygon) <= MAXIMUM_APARTMENT_AREA_SQUARE_METERS) return [[...polygon]];
  const bounds = polygonBounds(polygon);
  const longestAxis: CartesianAxis = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY
    ? "x"
    : "y";
  const split = safePolygonSplit(polygon, longestAxis, preferredAxis, openings);
  if (!split) throw new Error("The apartment area could not be divided safely.");
  return [
    ...partitionToMaximumArea(split.first, preferredAxis, openings),
    ...partitionToMaximumArea(split.second, preferredAxis, openings),
  ];
}

function addClippedRoom(
  rooms: LayoutRoom<BuildingRoomType>[],
  id: string,
  type: BuildingRoomType,
  footprint: readonly Point2D[],
  rectangle: Bounds2D,
  label?: string,
): void {
  const outer = clippedToOrientedRectangle(footprint, rectangle);
  if (polygonArea(outer) > 0.01) rooms.push({ id, type, polygon: { outer }, label });
}

function clippedToOrientedRectangle(
  footprint: readonly Point2D[],
  rectangle: Bounds2D,
): Point2D[] {
  let outer = clipPolygonAtAxis(footprint, "x", rectangle.minX, false);
  outer = clipPolygonAtAxis(outer, "x", rectangle.maxX, true);
  outer = clipPolygonAtAxis(outer, "y", rectangle.minY, false);
  return clipPolygonAtAxis(outer, "y", rectangle.maxY, true);
}

function orientedRect(
  horizontal: boolean,
  longMin: number,
  shortMin: number,
  longMax: number,
  shortMax: number,
): Bounds2D {
  return horizontal
    ? { minX: longMin, minY: shortMin, maxX: longMax, maxY: shortMax }
    : { minX: shortMin, minY: longMin, maxX: shortMax, maxY: longMax };
}

function safeStairMinimum(
  horizontal: boolean,
  longMin: number,
  longMax: number,
  serviceShortMin: number,
  serviceShortMax: number,
  stairLength: number,
  entrance: BuildingEntrance | undefined,
  openings: readonly Opening2D[],
): number {
  const centered = (longMin + longMax - stairLength) / 2;
  const maximumOffset = Math.max(0, (longMax - longMin - stairLength) / 2);
  const offsets = [0, 0.08, -0.08, 0.16, -0.16, 0.24, -0.24, 0.4, -0.4, 0.6, -0.6];
  const candidates = entrance
    ? [entrance.maximum, entrance.minimum - stairLength,
      ...offsets.map((fraction) => centered + maximumOffset * fraction)]
    : offsets.map((fraction) => centered + maximumOffset * fraction);
  for (const candidate of candidates) {
    if (candidate < longMin - 1e-7 || candidate + stairLength > longMax + 1e-7) continue;
    const firstWall: readonly [Point2D, Point2D] = horizontal
      ? [{ x: candidate, y: serviceShortMin }, { x: candidate, y: serviceShortMax }]
      : [{ x: serviceShortMin, y: candidate }, { x: serviceShortMax, y: candidate }];
    const second = candidate + stairLength;
    const secondWall: readonly [Point2D, Point2D] = horizontal
      ? [{ x: second, y: serviceShortMin }, { x: second, y: serviceShortMax }]
      : [{ x: serviceShortMin, y: second }, { x: serviceShortMax, y: second }];
    const exteriorWall: readonly [Point2D, Point2D] = horizontal
      ? [{ x: candidate, y: entrance?.side === "upper" ? serviceShortMax : serviceShortMin },
        { x: second, y: entrance?.side === "upper" ? serviceShortMax : serviceShortMin }]
      : [{ x: entrance?.side === "upper" ? serviceShortMax : serviceShortMin, y: candidate },
        { x: entrance?.side === "upper" ? serviceShortMax : serviceShortMin, y: second }];
    if (!openings.some((opening) =>
      segmentsIntersect(firstWall[0], firstWall[1], opening.start, opening.end) ||
      segmentsIntersect(secondWall[0], secondWall[1], opening.start, opening.end) ||
      segmentsIntersect(exteriorWall[0], exteriorWall[1], opening.start, opening.end))) {
      return candidate;
    }
  }
  throw new Error("The stair core could not be placed without blocking an opening.");
}

function exteriorEntrance(
  horizontal: boolean,
  longMin: number,
  longMax: number,
  shortMin: number,
  shortMax: number,
  openings: readonly Opening2D[],
): BuildingEntrance | undefined {
  const longAxis: CartesianAxis = horizontal ? "x" : "y";
  const shortAxis: CartesianAxis = horizontal ? "y" : "x";
  for (const opening of openings) {
    if (opening.type !== "door") continue;
    const onLower = Math.abs(opening.start[shortAxis] - shortMin) < 1e-7 &&
      Math.abs(opening.end[shortAxis] - shortMin) < 1e-7;
    const onUpper = Math.abs(opening.start[shortAxis] - shortMax) < 1e-7 &&
      Math.abs(opening.end[shortAxis] - shortMax) < 1e-7;
    if (!onLower && !onUpper) continue;
    const center = (opening.start[longAxis] + opening.end[longAxis]) / 2;
    const doorWidth = Math.abs(opening.end[longAxis] - opening.start[longAxis]);
    const lobbyWidth = Math.max(2.4, doorWidth + 0.8);
    const minimum = Math.max(longMin, Math.min(longMax - lobbyWidth, center - lobbyWidth / 2));
    return { minimum, maximum: minimum + lobbyWidth, side: onLower ? "lower" : "upper" };
  }
  return undefined;
}

function remainingIntervals(
  minimum: number,
  maximum: number,
  excluded: readonly Interval[],
): Interval[] {
  const merged: Interval[] = [];
  for (const interval of [...excluded].sort((a, b) => a.minimum - b.minimum)) {
    const clamped = {
      minimum: Math.max(minimum, interval.minimum),
      maximum: Math.min(maximum, interval.maximum),
    };
    const previous = merged[merged.length - 1];
    if (previous && clamped.minimum <= previous.maximum + 1e-7) {
      previous.maximum = Math.max(previous.maximum, clamped.maximum);
    } else if (clamped.maximum > clamped.minimum + 1e-7) merged.push(clamped);
  }
  const result: Interval[] = [];
  let cursor = minimum;
  for (const interval of merged) {
    if (interval.minimum > cursor + 1e-7) result.push({ minimum: cursor, maximum: interval.minimum });
    cursor = Math.max(cursor, interval.maximum);
  }
  if (cursor < maximum - 1e-7) result.push({ minimum: cursor, maximum });
  return result;
}

function apartmentEntranceDoors(
  rooms: readonly LayoutRoom<BuildingRoomType>[],
): Opening2D[] {
  const hallway = rooms.find((room) => room.id === "hallway-1");
  if (!hallway) return [];
  return rooms
    .filter((room) => room.type === "apartment")
    .flatMap((room) => {
      const shared = longestSharedAxisAlignedSegment(
        room.polygon.outer,
        hallway.polygon.outer,
      );
      if (!shared) return [];
      const length = Math.hypot(shared[1].x - shared[0].x, shared[1].y - shared[0].y);
      if (length < 0.8) return [];
      const doorLength = Math.min(1, length * 0.5);
      const center = {
        x: (shared[0].x + shared[1].x) / 2,
        y: (shared[0].y + shared[1].y) / 2,
      };
      const horizontal = Math.abs(shared[0].y - shared[1].y) < 1e-7;
      return [{
        id: `${room.id}-door`,
        type: "door" as const,
        start: horizontal
          ? { x: center.x - doorLength / 2, y: center.y }
          : { x: center.x, y: center.y - doorLength / 2 },
        end: horizontal
          ? { x: center.x + doorLength / 2, y: center.y }
          : { x: center.x, y: center.y + doorLength / 2 },
      }];
    });
}

function longestSharedAxisAlignedSegment(
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
      const shared = overlappingAxisAlignedSegment(a, b, c, d);
      if (!shared) continue;
      const length = Math.hypot(shared[1].x - shared[0].x, shared[1].y - shared[0].y);
      if (length > longestLength) {
        longest = shared;
        longestLength = length;
      }
    }
  }
  return longest;
}

function overlappingAxisAlignedSegment(
  a: Point2D,
  b: Point2D,
  c: Point2D,
  d: Point2D,
): readonly [Point2D, Point2D] | undefined {
  const firstHorizontal = Math.abs(a.y - b.y) < 1e-7;
  const secondHorizontal = Math.abs(c.y - d.y) < 1e-7;
  if (firstHorizontal && secondHorizontal && Math.abs(a.y - c.y) < 1e-7) {
    const minimum = Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x));
    const maximum = Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x));
    return maximum > minimum + 1e-7
      ? [{ x: minimum, y: a.y }, { x: maximum, y: a.y }]
      : undefined;
  }
  const firstVertical = Math.abs(a.x - b.x) < 1e-7;
  const secondVertical = Math.abs(c.x - d.x) < 1e-7;
  if (firstVertical && secondVertical && Math.abs(a.x - c.x) < 1e-7) {
    const minimum = Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
    const maximum = Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
    return maximum > minimum + 1e-7
      ? [{ x: a.x, y: minimum }, { x: a.x, y: maximum }]
      : undefined;
  }
  return undefined;
}

function safePolygonSplit(
  polygon: readonly Point2D[],
  preferredAxis: CartesianAxis,
  fallbackAxis: CartesianAxis,
  openings: readonly Opening2D[],
): PolygonSplit | undefined {
  const axes = [...new Set<CartesianAxis>([
    preferredAxis,
    fallbackAxis,
    preferredAxis === "x" ? "y" : "x",
  ])];
  const bounds = polygonBounds(polygon);
  const offsets = [0, 0.025, -0.025, 0.05, -0.05, 0.1, -0.1, 0.15, -0.15];
  let best: { split: PolygonSplit; score: number } | undefined;
  axes.forEach((axis, axisIndex) => {
    const equal = splitConvexPolygonEqual(polygon, axis);
    if (!equal) return;
    const span = axis === "x" ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY;
    for (const offset of offsets) {
      const split = splitAtCoordinate(polygon, axis, equal.coordinate + span * offset);
      if (!split || openings.some((opening) => segmentsIntersect(
        split.wall[0], split.wall[1], opening.start, opening.end,
      ))) continue;
      const firstArea = polygonArea(split.first);
      const secondArea = polygonArea(split.second);
      const score = Math.abs(firstArea - secondArea) / (firstArea + secondArea) + axisIndex * 0.02;
      if (!best || score < best.score) best = { split, score };
    }
  });
  return best?.split;
}

function validatedOpenings(openings: readonly Opening2D[] | undefined): readonly Opening2D[] {
  const result = openings ?? [];
  for (const opening of result) {
    if (!opening.id ||
        !Number.isFinite(opening.start.x) || !Number.isFinite(opening.start.y) ||
        !Number.isFinite(opening.end.x) || !Number.isFinite(opening.end.y)) {
      throw new Error("Every opening needs an id and two finite endpoints.");
    }
  }
  return result;
}

function validatedConvexPolygon(polygon: Polygon2D, subject: string): Polygon2D {
  const outer = [...polygon.outer];
  if (outer.length > 1 && samePoint(outer[0], outer[outer.length - 1])) outer.pop();
  if (outer.length < 3 || !outer.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
    throw new Error(`A ${subject} polygon needs at least three finite points.`);
  }
  if (polygon.holes?.length) throw new Error("Building planning does not support polygon holes yet.");
  if (polygonArea(outer) < 0.01) throw new Error("Building polygon area is too small.");
  if (!isConvex(outer)) throw new Error("Building planning currently requires a convex polygon.");
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

function polygonBounds(points: readonly Point2D[]): Bounds2D {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function clipPolygonAtAxis(
  points: readonly Point2D[],
  axis: CartesianAxis,
  coordinate: number,
  keepLower: boolean,
): Point2D[] {
  if (points.length === 0) return [];
  const inside = (point: Point2D): boolean => keepLower
    ? point[axis] <= coordinate
    : point[axis] >= coordinate;
  const intersection = (start: Point2D, end: Point2D): Point2D => {
    const amount = (coordinate - start[axis]) / (end[axis] - start[axis]);
    return axis === "x"
      ? { x: coordinate, y: start.y + (end.y - start.y) * amount }
      : { x: start.x + (end.x - start.x) * amount, y: coordinate };
  };
  const output: Point2D[] = [];
  let start = points[points.length - 1];
  for (const end of points) {
    if (inside(end)) {
      if (!inside(start)) output.push(intersection(start, end));
      output.push(end);
    } else if (inside(start)) output.push(intersection(start, end));
    start = end;
  }
  return output;
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
    if (polygonArea(clipPolygonAtAxis(points, axis, middle, true)) < targetArea) low = middle;
    else high = middle;
  }
  const coordinate = (low + high) / 2;
  return splitAtCoordinate(points, axis, coordinate);
}

function splitAtCoordinate(
  points: readonly Point2D[],
  axis: CartesianAxis,
  coordinate: number,
): PolygonSplit | undefined {
  const first = clipPolygonAtAxis(points, axis, coordinate, true);
  const second = clipPolygonAtAxis(points, axis, coordinate, false);
  const wall = cutSegment(points, axis, coordinate);
  return first.length >= 3 && second.length >= 3 && wall
    ? { first, second, wall, coordinate }
    : undefined;
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
