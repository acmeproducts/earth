import { polygonArea } from "../core/PlanarGeometry";
import type {
  PlannedRoadPolygon,
  PlannedStreetLamp,
  PlanningPoint,
  RoadAndBuildingPlan,
  RoadAndBuildingPlanBounds,
} from "./RoadAndBuildingPlanner";

export interface RoadAndBuildingPlanSvgOptions {
  title?: string;
  width?: number;
  height?: number;
  padding?: number;
  background?: string;
  showLabels?: boolean;
  showCenterlines?: boolean;
}

/**
 * Produces a standalone, north-up SVG of the exact polygons emitted by the
 * road/building planning stage. It has no DOM or Babylon dependency, so it can
 * be used in browser diagnostics, tests, scripts, and future design tooling.
 */
export function renderRoadAndBuildingPlanSvg(
  plan: RoadAndBuildingPlan,
  options: RoadAndBuildingPlanSvgOptions = {},
): string {
  const width = positiveDimension(options.width, 900);
  const height = positiveDimension(options.height, 600);
  const padding = Math.max(0, finite(options.padding, 24));
  validateBounds(plan.bounds);
  const extentWidth = plan.bounds.maxX - plan.bounds.minX;
  const extentDepth = plan.bounds.maxZ - plan.bounds.minZ;
  const drawableWidth = Math.max(1, width - padding * 2);
  const drawableHeight = Math.max(1, height - padding * 2);
  const scale = Math.min(drawableWidth / extentWidth, drawableHeight / extentDepth);
  const offsetX = (width - extentWidth * scale) / 2;
  const offsetY = (height - extentDepth * scale) / 2;
  const project = (point: PlanningPoint): PlanningPoint => ({
    x: offsetX + (point.x - plan.bounds.minX) * scale,
    z: height - offsetY - (point.z - plan.bounds.minZ) * scale,
  });

  const title = options.title
    ? `<text x="${number(width / 2)}" y="18" text-anchor="middle" fill="#172033" font-family="sans-serif" font-size="16" font-weight="600">${escapeXml(options.title)}</text>`
    : "";
  const plots = plan.plots.map((plot) =>
    `<path data-kind="plot" data-source-id="${escapeXml(plot.sourceId)}" d="${polygonPath(plot.outline, [], project)}" fill="#dde8c8" stroke="#75894c" stroke-width="1" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/>`
  ).join("");
  const shoulders = plan.shoulders.map((road) => roadPath(road, "shoulder", project)).join("");
  const roads = plan.roads.map((road) => roadPath(road, "road", project)).join("");
  const centerlines = options.showCenterlines === false
    ? ""
    : uniqueMarkedSegments(plan.roads).map((road) => centerlinePath(road, project)).join("");
  const buildings = plan.buildingSites.map((building) => {
    const path = polygonPath(building.outline, building.holes, project);
    return `<path data-kind="building-site" data-source-id="${escapeXml(building.sourceId)}" d="${path}" fill="url(#building-fill)" stroke="#713f12" stroke-width="1.2" vector-effect="non-scaling-stroke" fill-rule="evenodd"/>`;
  }).join("");
  const plotBoundaries = plan.plotBoundaries.map((boundary) => {
    const start = project(boundary.path[0]);
    const end = project(boundary.path[1]);
    const stroke = boundary.style === "hedge" ? "#315b2c" : "#765035";
    return `<line data-kind="plot-boundary" data-source-id="${escapeXml(boundary.sourceId)}" data-boundary-style="${boundary.style}" x1="${number(start.x)}" y1="${number(start.z)}" x2="${number(end.x)}" y2="${number(end.z)}" stroke="${stroke}" stroke-width="2.4" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
  }).join("");
  const lamps = plan.streetLamps.map((lamp) => streetLampMark(lamp, project)).join("");
  const labels = options.showLabels === true
    ? featureLabels([...plan.roads, ...plan.buildingSites], project)
    : "";
  const extent = polygonPath([
    { x: plan.bounds.minX, z: plan.bounds.minZ },
    { x: plan.bounds.maxX, z: plan.bounds.minZ },
    { x: plan.bounds.maxX, z: plan.bounds.maxZ },
    { x: plan.bounds.minX, z: plan.bounds.maxZ },
  ], [], project);
  const defs = `<defs><linearGradient id="building-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fde7c2"/><stop offset="1" stop-color="#d6a85f"/></linearGradient><pattern id="dirt-fill" width="9" height="9" patternUnits="userSpaceOnUse"><rect width="9" height="9" fill="#9b7048"/><circle cx="2" cy="3" r="0.45" fill="#7c5738"/><circle cx="7" cy="7" r="0.35" fill="#bc9164"/></pattern><pattern id="unpaved-fill" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#b99a6b"/><circle cx="2" cy="3" r="0.7" fill="#806342"/><circle cx="7" cy="6" r="0.55" fill="#d8c29e"/></pattern><pattern id="ford-fill" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#6094ad"/><path d="M -2 3 Q 1 1 4 3 T 10 3 T 16 3" fill="none" stroke="#b9dcea" stroke-width="1"/></pattern></defs>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(options.title ?? "Road and building plan")}">${defs}<rect width="100%" height="100%" fill="${escapeXml(options.background ?? "#edf1e8")}"/>${title}<path d="${extent}" fill="none" stroke="#94a3b8" stroke-width="1" vector-effect="non-scaling-stroke"/>${plots}${shoulders}${roads}${centerlines}${buildings}${plotBoundaries}${lamps}${labels}</svg>`;
}

function roadPath(
  road: PlannedRoadPolygon,
  kind: "road" | "shoulder",
  project: (point: PlanningPoint) => PlanningPoint,
): string {
  const fill = kind === "shoulder" ? "#c9bea5" : roadFill(road);
  const stroke = kind === "shoulder" ? "#a99b7d" : roadStroke(road);
  return `<path data-kind="${kind}" data-source-id="${escapeXml(road.sourceId)}" data-visual-style="${road.visualStyle}" data-structure="${road.structure}" data-layer="${number(road.layer)}" d="${polygonPath(road.outline, [], project)}" fill="${fill}" stroke="${stroke}" stroke-width="${kind === "shoulder" ? "0.7" : "0.8"}" vector-effect="non-scaling-stroke"/>`;
}

function centerlinePath(
  road: PlannedRoadPolygon,
  project: (point: PlanningPoint) => PlanningPoint,
): string {
  if (road.visualStyle !== "marked") return "";
  const start = project(road.centerline[0]);
  const end = project(road.centerline[1]);
  if (Math.hypot(end.x - start.x, end.z - start.z) < 0.01) return "";
  return `<line data-kind="road-marking" data-source-id="${escapeXml(road.sourceId)}" x1="${number(start.x)}" y1="${number(start.z)}" x2="${number(end.x)}" y2="${number(end.z)}" stroke="#f8fafc" stroke-width="1.2" stroke-dasharray="7 6" vector-effect="non-scaling-stroke"/>`;
}

function streetLampMark(
  lamp: PlannedStreetLamp,
  project: (point: PlanningPoint) => PlanningPoint,
): string {
  const center = project(lamp.position);
  const fill = lamp.source === "mapped" ? "#f59e0b" : "#fbd77e";
  return `<circle data-kind="street-lamp" data-source-id="${escapeXml(lamp.sourceId)}" data-lamp-source="${lamp.source}" cx="${number(center.x)}" cy="${number(center.z)}" r="2.4" fill="${fill}" stroke="#44403c" stroke-width="1"/>`;
}

function uniqueMarkedSegments(roads: readonly PlannedRoadPolygon[]): PlannedRoadPolygon[] {
  const segments = new Map<string, PlannedRoadPolygon>();
  for (const road of roads) {
    if (road.visualStyle !== "marked") continue;
    const start = road.centerline[0];
    const end = road.centerline[1];
    const forward = start.x < end.x || (start.x === end.x && start.z <= end.z);
    const first = forward ? start : end;
    const second = forward ? end : start;
    const key = `${road.sourceId}/${number(first.x)}/${number(first.z)}/${number(second.x)}/${number(second.z)}`;
    if (!segments.has(key)) segments.set(key, road);
  }
  return [...segments.values()];
}

function featureLabels(
  features: readonly { sourceId: string; outline: readonly PlanningPoint[] }[],
  project: (point: PlanningPoint) => PlanningPoint,
): string {
  const representatives = new Map<string, typeof features[number]>();
  for (const feature of features) {
    const previous = representatives.get(feature.sourceId);
    if (!previous || polygonArea(feature.outline) > polygonArea(previous.outline)) {
      representatives.set(feature.sourceId, feature);
    }
  }
  return [...representatives.values()].map(({ sourceId, outline }) => {
    if (outline.length === 0) return "";
    const center = project(outline.reduce((sum, point) => ({
      x: sum.x + point.x / outline.length,
      z: sum.z + point.z / outline.length,
    }), { x: 0, z: 0 }));
    return `<text x="${number(center.x)}" y="${number(center.z)}" text-anchor="middle" dominant-baseline="central" fill="#172033" font-family="sans-serif" font-size="10" paint-order="stroke" stroke="#ffffff" stroke-width="3">${escapeXml(sourceId)}</text>`;
  }).join("");
}

function roadFill(road: PlannedRoadPolygon): string {
  if (road.visualStyle === "dirt") return "url(#dirt-fill)";
  if (road.visualStyle === "unpaved") return "url(#unpaved-fill)";
  if (road.visualStyle === "ford") return "url(#ford-fill)";
  if (road.visualStyle === "pedestrian") return "#c9b8a6";
  return road.structure === "bridge" ? "#657080" : "#727b86";
}

function roadStroke(road: PlannedRoadPolygon): string {
  if (road.visualStyle === "ford") return "#34677d";
  if (road.visualStyle === "dirt") return "#6f4b2f";
  if (road.visualStyle === "unpaved") return "#806342";
  return road.structure === "bridge" ? "#283544" : "#4b5563";
}

function polygonPath(
  outline: readonly PlanningPoint[],
  holes: readonly (readonly PlanningPoint[])[],
  project: (point: PlanningPoint) => PlanningPoint,
): string {
  return [outline, ...holes].filter((ring) => ring.length > 0).map((ring) => {
    const points = ring.map(project);
    return `M ${points.map((point) => `${number(point.x)} ${number(point.z)}`).join(" L ")} Z`;
  }).join(" ");
}

function validateBounds(bounds: RoadAndBuildingPlanBounds): void {
  const values = [bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ];
  if (!values.every(Number.isFinite) || bounds.maxX <= bounds.minX || bounds.maxZ <= bounds.minZ) {
    throw new Error("Road and building plan bounds must be finite and have positive width and depth.");
  }
}

function positiveDimension(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
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
