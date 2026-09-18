import { number, escapeXml, positiveDimension, diagonalGradient } from "../core/Svg";
/** Cartesian coordinates in planner units (normally meters). */
export interface Point2D {
  x: number;
  y: number;
}

/** A simple outer ring with optional interior voids. Rings are implicitly closed. */
export interface Polygon2D {
  outer: readonly Point2D[];
  holes?: readonly (readonly Point2D[])[];
}

export type OpeningType = "door" | "window";

/** A door or window represented by its segment in planner coordinates. */
export interface Opening2D {
  id: string;
  type: OpeningType;
  start: Point2D;
  end: Point2D;
  /** An unobstructed passage, including the space above normal door height. */
  fullHeight?: boolean;
}

export interface LayoutRoom<RoomType extends string = string> {
  id: string;
  type: RoomType;
  polygon: Polygon2D;
  label?: string;
}

/** Shared data contract used by building, apartment, and future 2D planners. */
export interface PolygonLayout<RoomType extends string = string> {
  boundary: Polygon2D;
  rooms: readonly LayoutRoom<RoomType>[];
  openings?: readonly Opening2D[];
}

export interface RoomRenderStyle {
  fill: string;
  stroke?: string;
  text?: string;
}

export interface FloorPlanSvgOptions {
  title?: string;
  width?: number;
  height?: number;
  padding?: number;
  showLabels?: boolean;
  background?: string;
  /** Width of interior partition lines in rendered SVG pixels. */
  wallWidth?: number;
  roomStyles?: Readonly<Record<string, RoomRenderStyle>>;
}

export function segmentsIntersect(
  firstStart: Point2D,
  firstEnd: Point2D,
  secondStart: Point2D,
  secondEnd: Point2D,
): boolean {
  const epsilon = 1e-7;
  const orientation = (a: Point2D, b: Point2D, c: Point2D): number =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const onSegment = (a: Point2D, point: Point2D, b: Point2D): boolean =>
    point.x >= Math.min(a.x, b.x) - epsilon && point.x <= Math.max(a.x, b.x) + epsilon &&
    point.y >= Math.min(a.y, b.y) - epsilon && point.y <= Math.max(a.y, b.y) + epsilon;
  const first = orientation(firstStart, firstEnd, secondStart);
  const second = orientation(firstStart, firstEnd, secondEnd);
  const third = orientation(secondStart, secondEnd, firstStart);
  const fourth = orientation(secondStart, secondEnd, firstEnd);
  const crosses = (a: number, b: number): boolean =>
    (a > epsilon && b < -epsilon) || (a < -epsilon && b > epsilon);
  return (crosses(first, second) && crosses(third, fourth)) ||
    (Math.abs(first) <= epsilon && onSegment(firstStart, secondStart, firstEnd)) ||
    (Math.abs(second) <= epsilon && onSegment(firstStart, secondEnd, firstEnd)) ||
    (Math.abs(third) <= epsilon && onSegment(secondStart, firstStart, secondEnd)) ||
    (Math.abs(fourth) <= epsilon && onSegment(secondStart, firstEnd, secondEnd));
}

const DEFAULT_STYLES: Readonly<Record<string, RoomRenderStyle>> = {
  apartment: { fill: "url(#apartment-fill)", text: "#183b2e" },
  room: { fill: "url(#room-fill)", text: "#39245d" },
  "living-room": { fill: "url(#room-fill-0)", text: "#39245d" },
  toilet: { fill: "url(#room-fill-1)", text: "#17436b" },
  kitchen: { fill: "url(#room-fill-2)", text: "#7c4318" },
  hallway: { fill: "url(#hallway-fill)", text: "#6c3615" },
  stairs: { fill: "url(#stairs-fill)", text: "#17436b" },
};

/**
 * Produces a standalone SVG image. It has no DOM dependency, so plans can be
 * rendered in the browser, tests, build scripts, or a future design service.
 */
export function renderFloorPlanSvg(
  layout: PolygonLayout,
  options: FloorPlanSvgOptions = {},
): string {
  const width = positiveDimension(options.width, 900);
  const height = positiveDimension(options.height, 600);
  const padding = Math.max(0, options.padding ?? 24);
  const bounds = polygonBounds(layout.boundary);
  const drawableWidth = Math.max(1, width - padding * 2);
  const drawableHeight = Math.max(1, height - padding * 2);
  const scale = Math.min(
    drawableWidth / Math.max(bounds.maxX - bounds.minX, Number.EPSILON),
    drawableHeight / Math.max(bounds.maxY - bounds.minY, Number.EPSILON),
  );
  const offsetX = (width - (bounds.maxX - bounds.minX) * scale) / 2;
  const offsetY = (height - (bounds.maxY - bounds.minY) * scale) / 2;
  const project = (point: Point2D): Point2D => ({
    x: offsetX + (point.x - bounds.minX) * scale,
    y: height - offsetY - (point.y - bounds.minY) * scale,
  });
  const roomStyles = { ...DEFAULT_STYLES, ...options.roomStyles };
  const wallWidth = Math.max(0.5, options.wallWidth ?? 0.9);
  const rooms = layout.rooms.map((room, roomIndex) => {
    const style = roomStyles[room.type] ?? { fill: "#e5e7eb", text: "#1f2937" };
    const fill = room.type === "room" && style.fill === DEFAULT_STYLES.room.fill
      ? `url(#room-fill-${roomIndex % 4})`
      : style.fill;
    const path = polygonPath(room.polygon, project);
    const label = room.label ?? titleCase(room.type);
    const center = project(polygonCentroid(room.polygon.outer));
    const text = options.showLabels === false
      ? ""
      : `<text x="${number(center.x)}" y="${number(center.y)}" text-anchor="middle" dominant-baseline="central" fill="${escapeXml(style.text ?? "#1f2937")}" font-family="sans-serif" font-size="13">${escapeXml(label)}</text>`;
    return `<g data-room-id="${escapeXml(room.id)}" data-room-type="${escapeXml(room.type)}"><path d="${path}" fill="${escapeXml(fill)}" stroke="${escapeXml(style.stroke ?? "#334155")}" stroke-width="${number(wallWidth)}" vector-effect="non-scaling-stroke" fill-rule="evenodd"/>${text}</g>`;
  }).join("");
  const outline = polygonPath(layout.boundary, project);
  const openings = (layout.openings ?? []).map((opening) => {
    const start = project(opening.start);
    const end = project(opening.end);
    const color = opening.type === "window" ? "#2563eb" : "#b45309";
    return `<line data-opening-id="${escapeXml(opening.id)}" data-opening-type="${opening.type}" x1="${number(start.x)}" y1="${number(start.y)}" x2="${number(end.x)}" y2="${number(end.y)}" stroke="${color}" stroke-width="5" stroke-linecap="square" vector-effect="non-scaling-stroke"/>`;
  }).join("");

  const title = options.title
    ? `<text x="${number(width / 2)}" y="18" text-anchor="middle" fill="#111827" font-family="sans-serif" font-size="16" font-weight="600">${escapeXml(options.title)}</text>`
    : "";
  const defs = `<defs>${diagonalGradient("apartment-fill", "#edf8ed", "#b9ddc1")}${diagonalGradient("room-fill-0", "#f7f2ff", "#d8c6ed")}${diagonalGradient("room-fill-1", "#eff7ff", "#c5dcef")}${diagonalGradient("room-fill-2", "#fff7ee", "#f1d1ac")}${diagonalGradient("room-fill-3", "#f1fbf7", "#c4e2d2")}${diagonalGradient("hallway-fill", "#fff5e9", "#f2c999")}${diagonalGradient("stairs-fill", "#edf8ff", "#b9d9ed")}</defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(options.title ?? "Floor plan")}">${defs}<rect width="100%" height="100%" fill="${escapeXml(options.background ?? "#f8fafc")}"/>${title}${rooms}<path d="${outline}" fill="none" stroke="#172033" stroke-width="1.6" vector-effect="non-scaling-stroke" fill-rule="evenodd"/>${openings}</svg>`;
}

function polygonPath(polygon: Polygon2D, project: (point: Point2D) => Point2D): string {
  return [polygon.outer, ...(polygon.holes ?? [])]
    .filter((ring) => ring.length > 0)
    .map((ring) => {
      const points = ring.map(project);
      return `M ${points.map((point) => `${number(point.x)} ${number(point.y)}`).join(" L ")} Z`;
    })
    .join(" ");
}

function polygonBounds(polygon: Polygon2D): Bounds {
  if (polygon.outer.length < 3) throw new Error("A layout boundary needs at least three points.");
  const xs = polygon.outer.map((point) => point.x);
  const ys = polygon.outer.map((point) => point.y);
  if (![...xs, ...ys].every(Number.isFinite)) {
    throw new Error("Layout boundary coordinates must be finite.");
  }
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

function polygonCentroid(points: readonly Point2D[]): Point2D {
  let signedArea = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.y - next.x * current.y;
    signedArea += cross;
    x += (current.x + next.x) * cross;
    y += (current.y + next.y) * cross;
  }
  if (Math.abs(signedArea) < Number.EPSILON) return points[0] ?? { x: 0, y: 0 };
  return { x: x / (3 * signedArea), y: y / (3 * signedArea) };
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function titleCase(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
