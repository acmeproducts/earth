import { segmentsIntersect, type LayoutRoom, type Opening2D, type Point2D, type Polygon2D, type PolygonLayout } from "./FloorPlan";
import { planningFrameForPolygon, pointFromPlanningFrame, pointInPlanningFrame, type PlanningFrame2D } from "../core/PlanningFrame.mjs";
import { decomposeToConvexPolygons, mergeConvexNeighbours } from "../core/PolygonDecomposition.mjs";
import {
  longestSharedSegment as sharedSegment,
  splitAtCoordinate,
  splitConvexPolygonEqual,
  validatedPlanningPolygon,
  type PolygonSplit,
  overlappingSegment,
  polygonArea,
  polygonBounds,
  polygonMinimumMeanWidth,
  type CartesianAxis,
} from "../core/PolygonGeometry";

export const MINIMUM_ROOM_AREA_SQUARE_METERS = 12;
/** Keep generated rooms wide enough to furnish and move through comfortably. */
export const MINIMUM_ROOM_CLEAR_WIDTH_METERS = 2.8;
const MINIMUM_ALLOWED_ROOM_AREA_SQUARE_METERS = 12;
// Keep the upper bound high enough for large, open-plan apartments. Since
// subdivision stops once a piece would fall below twice this target, this
// also raises the largest room size the planner can intentionally retain.
const MAXIMUM_ALLOWED_ROOM_AREA_SQUARE_METERS = 60;

export type ApartmentRoomType = "room" | "living-room" | "bedroom" | "toilet" | "kitchen";

/** Rooms up to this area are suitable candidates for the first bathroom. */
export const SMALL_ROOM_AREA_SQUARE_METERS = 25;

export interface ApartmentPlannerInput {
  apartmentPolygon: Polygon2D;
  /** Inherit the parent building's wall axes when subdividing its apartments. */
  planningFrame?: PlanningFrame2D;
  openings?: readonly Opening2D[];
  /** Overrides the default room-size target for this apartment. */
  minimumRoomAreaSquareMeters?: number;
}

export interface ApartmentLayout extends PolygonLayout<ApartmentRoomType> {}

/** Keep the room target proportional to the apartment footprint. */
export function maximumMinimumRoomAreaForApartment(apartment: Polygon2D): number {
  return Math.max(
    MINIMUM_ALLOWED_ROOM_AREA_SQUARE_METERS,
    Math.min(MAXIMUM_ALLOWED_ROOM_AREA_SQUARE_METERS, polygonArea(apartment.outer) / 2),
  );
}

/** Recursively bisects an apartment into balanced rooms using orthogonal walls. */
export function planApartmentLayout(input: ApartmentPlannerInput): ApartmentLayout {
  const frame = input.planningFrame ?? planningFrameForPolygon(input.apartmentPolygon.outer);
  const toLocal = (point: Point2D): Point2D => pointInPlanningFrame(point, frame);
  const toWorld = (point: Point2D): Point2D => pointFromPlanningFrame(point, frame);
  const minimumRoomArea = validatedMinimumRoomArea(
    input.minimumRoomAreaSquareMeters,
    maximumMinimumRoomAreaForApartment(input.apartmentPolygon),
  );
  const layout = planApartmentLayoutInLocalFrame({
    apartmentPolygon: { outer: input.apartmentPolygon.outer.map(toLocal) },
    minimumRoomAreaSquareMeters: minimumRoomArea,
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
  const minimumRoomArea = input.minimumRoomAreaSquareMeters ?? MINIMUM_ROOM_AREA_SQUARE_METERS;
  const boundary = validatedConvexPolygon(input.apartmentPolygon, "apartment");
  if (polygonArea(boundary.outer) < minimumRoomArea - 1e-7) {
    throw new Error(`An apartment needs at least ${minimumRoomArea} square meters.`);
  }
  const openings = input.openings ?? [];
  const polygons = subdivideRooms(boundary.outer, openings, minimumRoomArea);
  const rooms: LayoutRoom<ApartmentRoomType>[] = polygons.map((outer, index) => ({
    id: `room-${index + 1}`,
    type: "room",
    polygon: { outer },
    label: `Room ${index + 1}`,
  }));
  assignApartmentRoomTypes(rooms, openings);
  return { boundary, rooms, openings: [...openings, ...internalRoomDoors(rooms, openings)] };
}

/**
 * Assigns the first useful room functions in a finished apartment.
 *
 * The assignment is deliberately deterministic: when several rooms qualify
 * for the toilet, the smallest one wins, and the largest remaining room gets
 * the kitchen. Remaining rooms become bedrooms, with a separate living room
 * when at least two rooms remain.
 *
 * A toilet is always a dead end. Rooms that hold an entrance door, or whose
 * removal would cut the apartment in two, never become the toilet, so no
 * route between two other rooms ever leads through it.
 */
export function assignApartmentRoomTypes(
  rooms: LayoutRoom<ApartmentRoomType>[],
  openings: readonly Opening2D[] = [],
): void {
  if (rooms.length === 0) return;
  if (rooms.length === 1) {
    rooms[0].type = "living-room";
    rooms[0].label = "Living room";
    return;
  }

  const area = (room: LayoutRoom<ApartmentRoomType>): number => polygonArea(room.polygon.outer);
  const comparePosition = (
    first: LayoutRoom<ApartmentRoomType>,
    second: LayoutRoom<ApartmentRoomType>,
  ): number => {
    const firstCenter = polygonCenter(first.polygon.outer);
    const secondCenter = polygonCenter(second.polygon.outer);
    return firstCenter.x - secondCenter.x || firstCenter.y - secondCenter.y || first.id.localeCompare(second.id);
  };
  const compareArea = (
    first: LayoutRoom<ApartmentRoomType>,
    second: LayoutRoom<ApartmentRoomType>,
  ): number => {
    const difference = area(first) - area(second);
    return Math.abs(difference) > 1e-7 ? difference : comparePosition(first, second);
  };
  const adjacency = roomAdjacency(rooms);
  const smallRoom = rooms
    .filter((room, index) => area(room) <= SMALL_ROOM_AREA_SQUARE_METERS + 1e-7 &&
      !roomHasDoor(room, openings) &&
      !isPassThroughRoom(index, adjacency))
    .sort(compareArea)[0];
  if (smallRoom) {
    smallRoom.type = "toilet";
    smallRoom.label = "Toilet";
  }

  const kitchen = rooms
    .filter((room) => room !== smallRoom)
    .sort((first, second) => compareArea(second, first))[0];
  if (kitchen) {
    kitchen.type = "kitchen";
    kitchen.label = "Kitchen";
  }

  const remaining = rooms.filter((room) => room !== smallRoom && room !== kitchen)
    .sort((first, second) => compareArea(second, first));
  if (remaining.length > 1) {
    const livingRoom = remaining.shift()!;
    livingRoom.type = "living-room";
    livingRoom.label = "Living room";
  }
  remaining.sort(comparePosition).forEach((room, index) => {
    room.type = "bedroom";
    room.label = remaining.length === 1 ? "Bedroom" : `Bedroom ${index + 1}`;
  });
}

function polygonCenter(points: readonly Point2D[]): Point2D {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

/** True when removing the room would leave some other rooms unreachable from the rest. */
function isPassThroughRoom(index: number, adjacency: readonly (readonly boolean[])[]): boolean {
  const count = adjacency.length;
  if (count < 3) return false;
  const start = index === 0 ? 1 : 0;
  const reached = new Set<number>([start]);
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (let other = 0; other < count; other++) {
      if (other === index || reached.has(other) || !adjacency[current][other]) continue;
      reached.add(other);
      pending.push(other);
    }
  }
  return reached.size < count - 1;
}

function roomAdjacency(rooms: readonly LayoutRoom<ApartmentRoomType>[]): boolean[][] {
  return rooms.map((room) => rooms.map((other) =>
    other !== room && sharedSegment(room.polygon.outer, other.polygon.outer) !== undefined));
}

/** True when a door opening lies along one of the room's walls. */
function roomHasDoor(room: LayoutRoom<ApartmentRoomType>, openings: readonly Opening2D[]): boolean {
  const points = room.polygon.outer;
  return openings.some((opening) => opening.type === "door" && points.some((a, index) => {
    const b = points[(index + 1) % points.length];
    const overlap = overlappingSegment(a, b, opening.start, opening.end);
    return overlap !== undefined && Math.hypot(overlap[1].x - overlap[0].x, overlap[1].y - overlap[0].y) > 1e-4;
  }));
}

/**
 * Connects every room with a spanning tree of doors along the longest shared
 * walls. The tree grows from a room with an entrance door and never grows
 * out of a toilet, so a toilet only ever has the single door that leads in.
 */
function internalRoomDoors(
  rooms: readonly LayoutRoom<ApartmentRoomType>[],
  openings: readonly Opening2D[],
): Opening2D[] {
  if (rooms.length < 2) return [];
  const isToilet = (index: number): boolean => rooms[index].type === "toilet";
  const startIndex = [
    rooms.findIndex((room, index) => !isToilet(index) && roomHasDoor(room, openings)),
    rooms.findIndex((_, index) => !isToilet(index)),
    0,
  ].find((index) => index >= 0)!;
  const connected = new Set<number>([startIndex]);
  const doors: Opening2D[] = [];
  while (connected.size < rooms.length) {
    let best: { from: number; to: number; segment: readonly [Point2D, Point2D]; length: number } | undefined;
    // Toilets are only used as a source when nothing else can reach a room,
    // so connectivity still wins over the dead-end rule in degenerate plans.
    for (const allowToilets of [false, true]) {
      for (const from of connected) {
        if (!allowToilets && isToilet(from)) continue;
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
      if (best) break;
    }
    if (!best) break;
    connected.add(best.to);
    const width = Math.min(1.1, Math.max(0.85, best.length - 0.3));
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

function subdivideRooms(
  polygon: readonly Point2D[],
  openings: readonly Opening2D[],
  minimumRoomArea: number,
): Point2D[][] {
  if (polygonArea(polygon) < minimumRoomArea * 2 - 1e-7) {
    return [[...polygon]];
  }
  const split = bestSplit(polygon, openings, minimumRoomArea);
  if (split) {
    return [
      ...subdivideRooms(split.first, openings, minimumRoomArea),
      ...subdivideRooms(split.second, openings, minimumRoomArea),
    ];
  }

  const pieces = decomposeToConvexPolygons(polygon);
  if (pieces.length === 1) return [[...polygon]];
  const merged = mergeUndersizedConvexPieces(pieces, minimumRoomArea);
  // Decomposition is a local fallback for topology that an axis-aligned wall
  // cannot cross once. It must not choose the first walls for the whole shell.
  return merged && merged.every((piece) => isUsableRoom(piece, minimumRoomArea))
    ? merged.flatMap((piece) => subdivideRooms(piece, openings, minimumRoomArea))
    : [[...polygon]];
}

function bestSplit(
  polygon: readonly Point2D[],
  openings: readonly Opening2D[],
  minimumRoomArea: number,
): PolygonSplit | undefined {
  const bounds = polygonBounds(polygon);
  const preferredAxis: CartesianAxis = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY
    ? "x"
    : "y";
  const axes: readonly CartesianAxis[] = [preferredAxis, preferredAxis === "x" ? "y" : "x"];
  const offsets = [0, ...Array.from({ length: 16 }, (_, index) => {
    const offset = (index + 1) * 0.025;
    return [offset, -offset];
  }).flat()];
  for (const axis of axes) {
    const equal = splitConvexPolygonEqual(polygon, axis);
    if (!equal) continue;
    const span = axis === "x" ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY;
    let best: { split: PolygonSplit; imbalance: number; aspectPenalty: number } | undefined;
    for (const offset of offsets) {
      const split = splitAtCoordinate(polygon, axis, equal.coordinate + span * offset);
      if (!split ||
          !isUsableRoom(split.first, minimumRoomArea) ||
          !isUsableRoom(split.second, minimumRoomArea) ||
          openings.some((opening) => opening.type === "door" && segmentsIntersect(
            split.wall[0], split.wall[1], opening.start, opening.end,
          ))) {
        continue;
      }
      const firstArea = polygonArea(split.first);
      const secondArea = polygonArea(split.second);
      const imbalance = Math.abs(firstArea - secondArea) / (firstArea + secondArea);
      const aspectPenalty = Math.max(aspectRatio(split.first), aspectRatio(split.second));
      if (!best || imbalance < best.imbalance - 1e-7 ||
          (Math.abs(imbalance - best.imbalance) <= 1e-7 && aspectPenalty < best.aspectPenalty)) {
        best = { split, imbalance, aspectPenalty };
      }
    }
    // Axis priority is strict. Shape and opening constraints may force the
    // fallback axis, but aspect ratio can never outweigh a longest-axis cut.
    if (best) return best.split;
  }
  return undefined;
}

function isUsableRoom(polygon: readonly Point2D[], minimumRoomArea: number): boolean {
  if (polygonArea(polygon) < minimumRoomArea - 1e-7) return false;
  return polygonMinimumMeanWidth(polygon) >=
    MINIMUM_ROOM_CLEAR_WIDTH_METERS - 1e-7;
}

function mergeUndersizedConvexPieces(
  pieces: readonly Point2D[][],
  minimumRoomArea: number,
): Point2D[][] | undefined {
  const remaining = pieces.map((piece) => [...piece]);
  for (let attempts = 0; attempts < pieces.length * 2; attempts++) {
    const target = remaining.findIndex((piece) => !isUsableRoom(piece, minimumRoomArea));
    if (target < 0) return remaining;
    let best: { index: number; polygon: Point2D[]; score: number } | undefined;
    for (let index = 0; index < remaining.length; index++) {
      if (index === target) continue;
      const merged = mergeConvexNeighbours(remaining[target], remaining[index])?.polygon;
      if (!merged) continue;
      const area = polygonArea(merged);
      const score = (isUsableRoom(merged, minimumRoomArea) ? 1_000_000 : 0) + area;
      if (!best || score > best.score) best = { index, polygon: merged, score };
    }
    if (!best) return undefined;
    const keep = Math.min(target, best.index);
    const remove = Math.max(target, best.index);
    remaining[keep] = best.polygon;
    remaining.splice(remove, 1);
  }
  return remaining.every((piece) => isUsableRoom(piece, minimumRoomArea)) ? remaining : undefined;
}

function validatedMinimumRoomArea(value: number | undefined, maximumRoomArea: number): number {
  const minimumRoomArea = value ?? MINIMUM_ROOM_AREA_SQUARE_METERS;
  if (!Number.isFinite(minimumRoomArea) ||
      minimumRoomArea < MINIMUM_ALLOWED_ROOM_AREA_SQUARE_METERS ||
      minimumRoomArea > maximumRoomArea) {
    throw new Error(
      `minimumRoomAreaSquareMeters must be between ${MINIMUM_ALLOWED_ROOM_AREA_SQUARE_METERS} and ` +
      `${maximumRoomArea} square meters for this apartment.`,
    );
  }
  return minimumRoomArea;
}

function aspectRatio(points: readonly Point2D[]): number {
  const bounds = polygonBounds(points);
  const width = Math.max(bounds.maxX - bounds.minX, 1e-7);
  const height = Math.max(bounds.maxY - bounds.minY, 1e-7);
  return Math.max(width / height, height / width);
}

function validatedConvexPolygon(polygon: Polygon2D, subject: string): Polygon2D {
  return validatedPlanningPolygon(polygon, subject, "Apartment");
}
