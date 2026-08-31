import { segmentsIntersect, type LayoutRoom, type Opening2D, type Point2D, type Polygon2D, type PolygonLayout } from "./FloorPlan";
import { planningFrameForPolygon, pointFromPlanningFrame, pointInPlanningFrame } from "./PlanningFrame.mjs";
import { isConvexPolygon } from "./PolygonDecomposition.mjs";
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
const MINIMUM_APARTMENT_AREA_SQUARE_METERS = 12;

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
  const frame = planningFrameForPolygon(input.buildingPolygon.outer);
  const toLocal = (point: Point2D): Point2D => pointInPlanningFrame(point, frame);
  const toWorld = (point: Point2D): Point2D => pointFromPlanningFrame(point, frame);
  const layout = planBuildingLayoutInLocalFrame({
    ...input,
    buildingPolygon: {
      outer: input.buildingPolygon.outer.map(toLocal),
      holes: input.buildingPolygon.holes?.map((hole) => hole.map(toLocal)),
    },
    openings: input.openings?.map((opening) => ({
      ...opening,
      start: toLocal(opening.start),
      end: toLocal(opening.end),
    })),
  });
  const boundary = { outer: layout.boundary.outer.map(toWorld) };
  return {
    ...layout,
    boundary,
    rooms: layout.rooms.map((room) => ({
      ...room,
      polygon: room.polygon === layout.boundary
        ? boundary
        : { outer: room.polygon.outer.map(toWorld) },
    })),
    openings: layout.openings?.map((opening) => ({
      ...opening,
      start: toWorld(opening.start),
      end: toWorld(opening.end),
    })),
  };
}

function planBuildingLayoutInLocalFrame(input: BuildingPlannerInput): BuildingLayout {
  const boundary = validatedConvexPolygon(input.buildingPolygon, "building");
  const openings = validatedOpenings(input.openings);
  if (!isConvexPolygon(boundary.outer) && polygonArea(boundary.outer) > MAXIMUM_APARTMENT_AREA_SQUARE_METERS) {
    return {
      buildingType: input.buildingType,
      boundary,
      ...concaveBuildingPlan(boundary, openings),
    };
  }
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

function concaveBuildingPlan(
  boundary: Polygon2D,
  openings: readonly Opening2D[],
): { rooms: LayoutRoom<BuildingRoomType>[]; openings: readonly Opening2D[] } {
  const bounds = polygonBounds(boundary.outer);
  const horizontal = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY;
  const shortMin = horizontal ? bounds.minY : bounds.minX;
  const shortMax = horizontal ? bounds.maxY : bounds.maxX;
  const hallwayWidth = Math.min(2.4, Math.max(1.5, (shortMax - shortMin) * 0.18));
  // The band must include the exterior entry.  A centred corridor can look
  // plausible while leaving the front door directly in an apartment.
  const entrance = openings.find((opening) => opening.type === "door");
  const entranceShortCoordinate = entrance
    ? (entrance.start[horizontal ? "y" : "x"] + entrance.end[horizontal ? "y" : "x"]) / 2
    : (shortMin + shortMax) / 2;
  const hallwayMin = Math.max(
    shortMin,
    Math.min(shortMax - hallwayWidth, entranceShortCoordinate - hallwayWidth / 2),
  );
  const hallwayMax = hallwayMin + hallwayWidth;
  let hallwayOuter = clippedToOrientedRectangle(boundary.outer, orientedRect(
    horizontal,
    horizontal ? bounds.minX : bounds.minY,
    hallwayMin,
    horizontal ? bounds.maxX : bounds.maxY,
    hallwayMax,
  ));
  let apartmentPolygons: Point2D[][];
  try {
    // Most concave footprints retain one continuous cross-section along their
    // long axis. Splitting that complete outline makes broad apartments rather
    // than promoting every convex decomposition cell to an apartment.
    if (polygonArea(hallwayOuter) < 2) throw new Error("No continuous hallway band.");
    const lower = clippedToOrientedRectangle(boundary.outer, orientedRect(
      horizontal,
      horizontal ? bounds.minX : bounds.minY,
      shortMin,
      horizontal ? bounds.maxX : bounds.maxY,
      hallwayMin,
    ));
    const upper = clippedToOrientedRectangle(boundary.outer, orientedRect(
      horizontal,
      horizontal ? bounds.minX : bounds.minY,
      hallwayMax,
      horizontal ? bounds.maxX : bounds.maxY,
      shortMax,
    ));
    const apartmentRegions = [lower, upper].filter((polygon) => polygonArea(polygon) > 0.01);
    // Keep each side of the corridor as one broad shell. Subdividing a concave
    // side can strand a later slice behind the first apartment; a subsequent
    // hallway-branch strategy can split these shells without sacrificing
    // direct common-space access.
    apartmentPolygons = apartmentRegions;
  } catch {
    apartmentPolygons = [];
  }
  const hallwayFragments = apartmentPolygons.filter((polygon) =>
    polygonArea(polygon) < MINIMUM_APARTMENT_AREA_SQUARE_METERS - 1e-7);
  for (const fragment of hallwayFragments) {
    const merged = mergeNeighbouringPolygons(hallwayOuter, fragment);
    if (merged) hallwayOuter = merged;
  }
  apartmentPolygons = mergeApartmentsWithoutHallway(
    apartmentPolygons.filter((polygon) => polygonArea(polygon) >= MINIMUM_APARTMENT_AREA_SQUARE_METERS - 1e-7),
    hallwayOuter,
  );
  const rooms: LayoutRoom<BuildingRoomType>[] = [];
  if (polygonArea(hallwayOuter) >= 2) rooms.push({
    id: "hallway-1",
    type: "hallway",
    polygon: { outer: hallwayOuter },
    label: "Hallway",
  });
  rooms.push(...apartmentPolygons.map((outer, index) => ({
    id: `apartment-${index + 1}`,
    type: "apartment" as const,
    polygon: { outer },
    label: `Apartment ${index + 1}`,
  })));
  return {
    rooms,
    openings: [...openings, ...(rooms.some((room) => room.type === "hallway")
      ? sharedRoomEntranceDoors(rooms)
      : connectedApartmentDoors(rooms))],
  };
}

/**
 * A concave wing can be split into a piece that merely meets another
 * apartment at its tip. Merge that piece back into a neighbouring shell until
 * every resulting apartment has a real wall-length connection to the hall.
 */
function mergeApartmentsWithoutHallway(
  apartmentPolygons: readonly Point2D[][],
  hallway: readonly Point2D[],
): Point2D[][] {
  const pieces = apartmentPolygons.map((polygon) => [...polygon]);
  const touchesHallway = (polygon: readonly Point2D[]): boolean => {
    const shared = longestSharedSegment(polygon, hallway);
    return !!shared && Math.hypot(shared[1].x - shared[0].x, shared[1].y - shared[0].y) >= 0.8;
  };
  for (let attempts = 0; attempts < apartmentPolygons.length * 2; attempts++) {
    const target = pieces.findIndex((polygon) => !touchesHallway(polygon));
    if (target < 0) break;
    let best: { index: number; polygon: Point2D[]; length: number; servesHallway: boolean } | undefined;
    for (let index = 0; index < pieces.length; index++) {
      if (index === target) continue;
      const shared = longestSharedSegment(pieces[target], pieces[index]);
      if (!shared) continue;
      const merged = mergeNeighbouringPolygons(pieces[target], pieces[index]);
      if (!merged) continue;
      const length = Math.hypot(shared[1].x - shared[0].x, shared[1].y - shared[0].y);
      const servesHallway = touchesHallway(pieces[index]);
      if (!best || (servesHallway && !best.servesHallway) ||
          (servesHallway === best.servesHallway && length > best.length)) {
        best = { index, polygon: merged, length, servesHallway };
      }
    }
    if (!best) break;
    const keep = Math.min(target, best.index);
    const remove = Math.max(target, best.index);
    pieces[keep] = best.polygon;
    pieces.splice(remove, 1);
  }
  return pieces;
}

function mergeNeighbouringPolygons(
  first: readonly Point2D[],
  second: readonly Point2D[],
): Point2D[] | undefined {
  const edges = new Map<string, { start: Point2D; end: Point2D }>();
  for (const polygon of [first, second]) {
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const reverse = polygonEdgeKey(end, start);
      if (edges.has(reverse)) edges.delete(reverse);
      else edges.set(polygonEdgeKey(start, end), { start, end });
    }
  }
  if (edges.size >= first.length + second.length) return undefined;
  const remaining = [...edges.values()];
  const polygon = [remaining[0]?.start];
  if (!polygon[0]) return undefined;
  let end = remaining[0].end;
  remaining.splice(0, 1);
  while (remaining.length > 0) {
    polygon.push(end);
    const next = remaining.findIndex((edge) => samePoint(edge.start, end));
    if (next < 0) return undefined;
    end = remaining[next].end;
    remaining.splice(next, 1);
  }
  if (!samePoint(end, polygon[0]) || polygon.length < 3) return undefined;
  return removeCollinearPoints(polygon);
}

function polygonEdgeKey(start: Point2D, end: Point2D): string {
  return `${start.x.toFixed(7)},${start.y.toFixed(7)}>${end.x.toFixed(7)},${end.y.toFixed(7)}`;
}

function removeCollinearPoints(points: readonly Point2D[]): Point2D[] {
  return points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    return Math.abs((point.x - previous.x) * (next.y - point.y) -
      (point.y - previous.y) * (next.x - point.x)) > 1e-7;
  });
}

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
    openings: [...openings, ...sharedRoomEntranceDoors(rooms)],
  };
}

function partitionToMaximumArea(
  polygon: readonly Point2D[],
  preferredAxis: CartesianAxis,
  openings: readonly Opening2D[],
  restrictToPreferredAxis = false,
): Point2D[][] {
  if (polygonArea(polygon) <= MAXIMUM_APARTMENT_AREA_SQUARE_METERS) return [[...polygon]];
  const bounds = polygonBounds(polygon);
  const longestAxis: CartesianAxis = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY
    ? "x"
    : "y";
  const split = safePolygonSplit(
    polygon,
    restrictToPreferredAxis ? preferredAxis : longestAxis,
    restrictToPreferredAxis ? preferredAxis : preferredAxis,
    openings,
  );
  if (!split) throw new Error("The apartment area could not be divided safely.");
  return [
    ...partitionToMaximumArea(split.first, preferredAxis, openings, restrictToPreferredAxis),
    ...partitionToMaximumArea(split.second, preferredAxis, openings, restrictToPreferredAxis),
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

function sharedRoomEntranceDoors(
  rooms: readonly LayoutRoom<BuildingRoomType>[],
): Opening2D[] {
  const hallway = rooms.find((room) => room.id === "hallway-1");
  if (!hallway) return [];
  return rooms
    // The entrance lobby is a secondary hallway room. It needs its own
    // opening into the main hallway or the exterior door can lead into a
    // sealed pocket of the plan.
    .filter((room) => room.type === "apartment" || room.type === "stairs" ||
      (room.type === "hallway" && room.id !== "hallway-1"))
    .flatMap((room) => {
      const shared = longestSharedSegment(
        room.polygon.outer,
        hallway.polygon.outer,
      );
      if (!shared) return [];
      const length = Math.hypot(shared[1].x - shared[0].x, shared[1].y - shared[0].y);
      if (length < 0.8) return [];
      const doorLength = Math.min(1.15, length * 0.58);
      const center = {
        x: (shared[0].x + shared[1].x) / 2,
        y: (shared[0].y + shared[1].y) / 2,
      };
      const direction = {
        x: (shared[1].x - shared[0].x) / length,
        y: (shared[1].y - shared[0].y) / length,
      };
      return [{
        id: `${room.id}-door`,
        type: "door" as const,
        start: { x: center.x - direction.x * doorLength / 2, y: center.y - direction.y * doorLength / 2 },
        end: { x: center.x + direction.x * doorLength / 2, y: center.y + direction.y * doorLength / 2 },
      }];
    });
}

/** Keeps every convex piece of a concave footprint reachable from its entrance. */
function connectedApartmentDoors(rooms: readonly LayoutRoom<BuildingRoomType>[]): Opening2D[] {
  if (rooms.length < 2) return [];
  const connected = new Set<number>([0]);
  const doors: Opening2D[] = [];
  while (connected.size < rooms.length) {
    let best: { target: number; segment: readonly [Point2D, Point2D]; length: number } | undefined;
    for (const source of connected) {
      for (let target = 0; target < rooms.length; target++) {
        if (connected.has(target)) continue;
        const segment = longestSharedSegment(rooms[source].polygon.outer, rooms[target].polygon.outer);
        if (!segment) continue;
        const length = Math.hypot(segment[1].x - segment[0].x, segment[1].y - segment[0].y);
        if (!best || length > best.length) best = { target, segment, length };
      }
    }
    if (!best) break;
    connected.add(best.target);
    if (best.length < 0.8) continue;
    const width = Math.min(1, best.length * 0.5);
    const direction = {
      x: (best.segment[1].x - best.segment[0].x) / best.length,
      y: (best.segment[1].y - best.segment[0].y) / best.length,
    };
    const center = {
      x: (best.segment[0].x + best.segment[1].x) / 2,
      y: (best.segment[0].y + best.segment[1].y) / 2,
    };
    doors.push({
      id: `apartment-connection-${doors.length + 1}`,
      type: "door",
      start: { x: center.x - direction.x * width / 2, y: center.y - direction.y * width / 2 },
      end: { x: center.x + direction.x * width / 2, y: center.y + direction.y * width / 2 },
    });
  }
  return doors;
}

function longestSharedSegment(
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
      const shared = overlappingSegment(a, b, c, d);
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
  const projection = (point: Point2D): number =>
    ((point.x - a.x) * dx + (point.y - a.y) * dy) / length;
  const minimum = Math.max(0, Math.min(projection(c), projection(d)));
  const maximum = Math.min(length, Math.max(projection(c), projection(d)));
  return maximum - minimum > 1e-7
    ? [{ x: a.x + dx * minimum / length, y: a.y + dy * minimum / length },
      { x: a.x + dx * maximum / length, y: a.y + dy * maximum / length }]
    : undefined;
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

function samePoint(a: Point2D, b: Point2D): boolean {
  return a.x === b.x && a.y === b.y;
}
