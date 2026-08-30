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
  roomStyles?: Readonly<Record<string, RoomRenderStyle>>;
}

const DEFAULT_STYLES: Readonly<Record<string, RoomRenderStyle>> = {
  apartment: { fill: "#d9ead3", text: "#223322" },
  room: { fill: "#e4d7f5", text: "#352647" },
  hallway: { fill: "#fce5cd", text: "#4a3525" },
  stairs: { fill: "#cfe2f3", text: "#21394d" },
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
  const rooms = layout.rooms.map((room) => {
    const style = roomStyles[room.type] ?? { fill: "#e5e7eb", text: "#1f2937" };
    const path = polygonPath(room.polygon, project);
    const label = room.label ?? titleCase(room.type);
    const center = project(polygonCentroid(room.polygon.outer));
    const text = options.showLabels === false
      ? ""
      : `<text x="${number(center.x)}" y="${number(center.y)}" text-anchor="middle" dominant-baseline="central" fill="${escapeXml(style.text ?? "#1f2937")}" font-family="sans-serif" font-size="13">${escapeXml(label)}</text>`;
    return `<g data-room-id="${escapeXml(room.id)}" data-room-type="${escapeXml(room.type)}"><path d="${path}" fill="${escapeXml(style.fill)}" stroke="${escapeXml(style.stroke ?? "#374151")}" stroke-width="1.5" vector-effect="non-scaling-stroke" fill-rule="evenodd"/>${text}</g>`;
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(options.title ?? "Floor plan")}"><rect width="100%" height="100%" fill="${escapeXml(options.background ?? "#ffffff")}"/>${title}${rooms}<path d="${outline}" fill="none" stroke="#111827" stroke-width="3" vector-effect="non-scaling-stroke" fill-rule="evenodd"/>${openings}</svg>`;
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

function positiveDimension(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function titleCase(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function number(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character] ?? character);
}
