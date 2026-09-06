import type { RoadPlan, RoadSurface, RoadVisualStyle } from "./RoadPlanner";
import earcut from "earcut";
import { hashString } from "./Random";
import {
  averagePoint,
  boundsOverlap,
  clipHalfPlane,
  clipToBounds,
  convexHull,
  convexPolygonsOverlap,
  cross,
  deduplicateRing,
  distanceToRing,
  offsetConvexPolygon,
  PlanarCellIndex,
  pointBounds,
  pointInRing,
  polygonArea,
  polygonsOverlapArea,
  removeCollinearPoints,
  samePoint,
  segmentIntersection,
  signedArea,
  subtractConvex,
  withoutClosingPoint,
  type PlanarBounds,
  type PlanarPoint,
} from "./PlanarGeometry";

export type PlanningPoint = PlanarPoint;

export interface PlanningRoadInput {
  id: string;
  paths: ReadonlyArray<ReadonlyArray<PlanningPoint>>;
  appearance: RoadPlan;
}

export interface PlanningBuildingInput {
  id: string;
  outline: ReadonlyArray<PlanningPoint>;
  holes?: ReadonlyArray<ReadonlyArray<PlanningPoint>>;
}

export interface PlannedRoadPolygon {
  sourceId: string;
  outline: PlanningPoint[];
  centerline: readonly [PlanningPoint, PlanningPoint];
  /**
   * Normalized span of the centerline over which the grade rises. Outside it
   * the polygon is level with the junction disc it runs into, so a short piece
   * between two junctions cannot step at the seam.
   */
  gradeRange: readonly [number, number];
  /** Optional direction used only to keep strip textures coherent across joins. */
  textureAxis?: readonly [PlanningPoint, PlanningPoint];
  /** Distance from the beginning of the source path to centerline[0], in scene units. */
  startDistance: number;
  widthMeters: number;
  shoulderWidthMeters: number;
  visualStyle: RoadVisualStyle;
  surface: RoadSurface;
  structure: RoadPlan["structure"];
  layer: number;
}

export interface PlannedBuildingSite {
  sourceId: string;
  outline: PlanningPoint[];
  holes: PlanningPoint[][];
}

export interface PlanningLampInput {
  id: string;
  position: PlanningPoint;
}

export interface PlannedStreetLamp {
  sourceId: string;
  position: PlanningPoint;
  /** Facing of the adjacent carriageway, radians about +Y. Mapped lamps use 0. */
  orientationRadians: number;
  source: "mapped" | "procedural";
}

/** Convex parcel around one building, butted against roads and neighbors. */
export interface PlannedPlot {
  sourceId: string;
  outline: PlanningPoint[];
}

export interface PlannedPlotBoundary {
  sourceId: string;
  style: "hedge" | "woodFence";
  path: readonly [PlanningPoint, PlanningPoint];
}

export type RoadAndBuildingPlanBounds = PlanarBounds;

export interface RoadAndBuildingPlan {
  /** Full scene-space planning extent, including portions without features. */
  bounds: RoadAndBuildingPlanBounds;
  /** Mutually exclusive carriageway polygons within each physical road layer. */
  roads: PlannedRoadPolygon[];
  /** Mutually exclusive outer road beds; carriageways render above them. */
  shoulders: PlannedRoadPolygon[];
  buildingSites: PlannedBuildingSite[];
  streetLamps: PlannedStreetLamp[];
  /** One plot per building site; plots attach to each other and to road beds. */
  plots: PlannedPlot[];
  /** Selective plot-edge treatments, with openings left toward adjacent roads. */
  plotBoundaries: PlannedPlotBoundary[];
}

export interface RoadAndBuildingPlanningOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
}

interface Candidate extends PlannedRoadPolygon {
  priority: number;
}

interface NetworkSegment {
  input: PlanningRoadInput;
  start: PlanningPoint;
  end: PlanningPoint;
  startDistance: number;
  length: number;
  splits: number[];
}

interface NetworkIncident {
  input: PlanningRoadInput;
  startDistance: number;
  textureAxis: readonly [PlanningPoint, PlanningPoint];
  /** True when the node sits at the piece's start rather than its end. */
  atStart: boolean;
  length: number;
}

interface NetworkNode {
  point: PlanningPoint;
  incidents: NetworkIncident[];
}

interface NetworkPiece {
  input: PlanningRoadInput;
  start: PlanningPoint;
  end: PlanningPoint;
  startDistance: number;
}

/**
 * Builds the horizontal construction plan before either terrain or meshes are
 * produced. Every buffered centerline is split into convex pieces and each
 * new piece is clipped against pieces already assigned to the same physical
 * layer. The resulting polygons touch at their shared boundaries but never
 * occupy the same area.
 */
export function planRoadsAndBuildings(
  roadInputs: readonly PlanningRoadInput[],
  buildingInputs: readonly PlanningBuildingInput[],
  options: RoadAndBuildingPlanningOptions,
  lampInputs: readonly PlanningLampInput[] = [],
): RoadAndBuildingPlan {
  const bounds = {
    minX: -options.meshWidth / 2,
    maxX: options.meshWidth / 2,
    minZ: -options.meshDepth / 2,
    maxZ: options.meshDepth / 2,
  };
  const { surfaceCandidates, outerCandidates } = buildRoadNetworkCandidates(
    roadInputs,
    options,
  );

  const roads = mergeCompatiblePolygons(partitionCandidates(
    triangulateCandidates(surfaceCandidates),
    bounds,
    options,
  ));
  const shoulders = mergeCompatiblePolygons(partitionCandidates(
    triangulateCandidates(outerCandidates),
    bounds,
    options,
  ));
  const buildingSites = buildingInputs.flatMap((building) => {
    const outline = clipToBounds(withoutClosingPoint(building.outline), bounds);
    if (outline.length < 3) return [];
    return [{
      sourceId: building.id,
      outline,
      holes: (building.holes ?? [])
        .map((hole) => clipToBounds(withoutClosingPoint(hole), bounds))
        .filter((hole) => hole.length >= 3),
    }];
  });

  const streetLamps = planStreetLamps(roadInputs, lampInputs, buildingSites, shoulders, bounds, options);
  const plots = planBuildingPlots(buildingSites, outerCandidates, bounds, options);
  const plotBoundaries = planPlotBoundaries(
    plots,
    buildingSites,
    outerCandidates,
    bounds,
    options,
  );
  return { bounds, roads, shoulders, buildingSites, streetLamps, plots, plotBoundaries };
}

const LAMP_SPACING_METERS = 34;
const MAPPED_LAMP_CLEARANCE_METERS = 25;
const LAMP_EDGE_MARGIN_METERS = 0.7;
const LAMP_BUILDING_DISTANCE_METERS = 50;
const LAMP_ROAD_CLASSES = new Set(["primary", "secondary", "tertiary", "minor", "service"]);
const PLOT_DEPTH_METERS = 12;
const PLOT_BOUNDARY_SHARE = 0.62;
const PLOT_EDGE_SHARE = 0.72;
const PLOT_ENTRANCE_METERS = 3.2;
const MINIMUM_BOUNDARY_RUN_METERS = 2.2;
const PLOT_BUILDING_CLEARANCE_METERS = 2.5;

/**
 * Selects a restrained, repeatable subset of road and neighbor contacts.
 * Unsupported outer edges face open land and remain untreated. Road-facing edges
 * receive an entrance gap; clipping edges at the tile bounds are never made
 * visible because they are data boundaries rather than real parcel lines.
 */
function planPlotBoundaries(
  plots: readonly PlannedPlot[],
  buildingSites: readonly PlannedBuildingSite[],
  roadCandidates: readonly Candidate[],
  bounds: RoadAndBuildingPlanBounds,
  options: RoadAndBuildingPlanningOptions,
): PlannedPlotBoundary[] {
  const minimumRun = MINIMUM_BOUNDARY_RUN_METERS / options.metersPerUnit;
  const entrance = PLOT_ENTRANCE_METERS / options.metersPerUnit;
  const roadTolerance = 0.12 / options.metersPerUnit;
  const buildingClearance = PLOT_BUILDING_CLEARANCE_METERS / options.metersPerUnit;
  const buildingIndex = new PlanarCellIndex<PlannedBuildingSite>(planningCellSize(options));
  const plotIndex = new PlanarCellIndex<PlannedPlot>(planningCellSize(options));
  const roadIndex = new PlanarCellIndex<Candidate>(planningCellSize(options));
  for (const plot of plots) plotIndex.add(plot, pointBounds(plot.outline), roadTolerance);
  for (const road of roadCandidates) {
    if (road.structure !== "bridge") roadIndex.add(road, pointBounds(road.outline), roadTolerance);
  }
  for (const site of buildingSites) {
    buildingIndex.add(site, pointBounds(site.outline), buildingClearance);
  }
  const usedEdges = new Set<string>();
  const boundaries: PlannedPlotBoundary[] = [];

  for (const plot of plots) {
    if (hashUnit(`${plot.sourceId}/plot-boundary`) >= PLOT_BOUNDARY_SHARE) continue;
    const style = hashUnit(`${plot.sourceId}/plot-boundary-style`) < 0.72
      ? "hedge" as const
      : "woodFence" as const;
    const candidates: Array<{
      start: PlanningPoint; end: PlanningPoint; key: string; score: number; facesRoad: boolean;
    }> = [];
    for (let index = 0; index < plot.outline.length; index++) {
      const start = plot.outline[index];
      const end = plot.outline[(index + 1) % plot.outline.length];
      const length = Math.hypot(end.x - start.x, end.z - start.z);
      if (length < minimumRun || liesOnPlanningBounds(start, end, bounds)) continue;
      const edgeBounds = pointBounds([start, end]);
      const contacts = [
        ...roadIndex.query(edgeBounds).map((road) => ({ outline: road.outline, facesRoad: true })),
        ...plotIndex.query(edgeBounds).filter((neighbor) => neighbor !== plot)
          .map((neighbor) => ({ outline: neighbor.outline, facesRoad: false })),
      ];
      for (const contact of plotEdgeContacts(start, end, contacts, roadTolerance)) {
        const contactStart = interpolate(start, end, contact.from);
        const contactEnd = interpolate(start, end, contact.to);
        if ((contact.to - contact.from) * length < minimumRun ||
            !edgeClearsBuildings(contactStart, contactEnd, buildingIndex, buildingClearance)) continue;
        const key = undirectedEdgeKey(contactStart, contactEnd);
        if (usedEdges.has(key)) continue;
        candidates.push({
          start: contactStart,
          end: contactEnd,
          key,
          facesRoad: contact.facesRoad,
          score: hashUnit(`${plot.sourceId}/plot-edge/${key}`),
        });
      }
    }

    // Even selected parcels remain visually porous: cap ordinary plots at
    // three treated sides and let the per-edge draw leave some plots sparser.
    const selected = candidates
      .filter((edge) => edge.score < PLOT_EDGE_SHARE)
      .sort((a, b) => a.score - b.score)
      .slice(0, 3);
    for (const edge of selected) {
      usedEdges.add(edge.key);
      const length = Math.hypot(edge.end.x - edge.start.x, edge.end.z - edge.start.z);
      if (edge.facesRoad && length >= entrance + minimumRun * 2) {
        const halfGap = entrance / length / 2;
        boundaries.push(
          { sourceId: plot.sourceId, style, path: [edge.start, interpolate(edge.start, edge.end, 0.5 - halfGap)] },
          { sourceId: plot.sourceId, style, path: [interpolate(edge.start, edge.end, 0.5 + halfGap), edge.end] },
        );
      } else if (!edge.facesRoad) {
        boundaries.push({ sourceId: plot.sourceId, style, path: [edge.start, edge.end] });
      }
    }
  }
  return boundaries;
}

/** Project parallel boundary contacts onto an edge; point contacts do not count. */
function plotEdgeContacts(
  start: PlanningPoint,
  end: PlanningPoint,
  contacts: readonly { outline: readonly PlanningPoint[]; facesRoad: boolean }[],
  tolerance: number,
): Array<{ from: number; to: number; facesRoad: boolean }> {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  const spans: Array<{ from: number; to: number; facesRoad: boolean }> = [];
  for (const contact of contacts) {
    for (let index = 0; index < contact.outline.length; index++) {
      const a = contact.outline[index];
      const b = contact.outline[(index + 1) % contact.outline.length];
      if (Math.abs(cross(start, end, a)) / length > tolerance ||
          Math.abs(cross(start, end, b)) / length > tolerance) continue;
      const project = (point: PlanningPoint) =>
        ((point.x - start.x) * dx + (point.z - start.z) * dz) / (length * length);
      const first = project(a);
      const second = project(b);
      const from = Math.max(0, Math.min(first, second));
      const to = Math.min(1, Math.max(first, second));
      if (to - from > 1e-8) spans.push({ from, to, facesRoad: contact.facesRoad });
    }
  }
  // Road beds are split into several polygons; reunite their contact spans
  // before choosing barriers and cutting one entrance into the frontage.
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: typeof spans = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span.from <= previous.to + 1e-8) {
      previous.to = Math.max(previous.to, span.to);
      previous.facesRoad ||= span.facesRoad;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function edgeClearsBuildings(
  start: PlanningPoint,
  end: PlanningPoint,
  buildingIndex: PlanarCellIndex<PlannedBuildingSite>,
  clearance: number,
): boolean {
  const nearby = buildingIndex.query(pointBounds([start, end]));
  if (nearby.length === 0) return true;
  const length = Math.hypot(end.x - start.x, end.z - start.z);
  const steps = Math.max(1, Math.ceil(length / Math.max(clearance / 3, 1e-6)));
  for (let step = 0; step <= steps; step++) {
    const point = interpolate(start, end, step / steps);
    if (nearby.some((site) =>
      pointInRing(point, site.outline) || distanceToRing(point, site.outline) < clearance
    )) return false;
  }
  return true;
}

function hashUnit(value: string): number {
  return (hashString(value) >>> 0) / 4_294_967_296;
}

function liesOnPlanningBounds(
  start: PlanningPoint,
  end: PlanningPoint,
  bounds: RoadAndBuildingPlanBounds,
): boolean {
  const epsilon = 1e-8;
  return (Math.abs(start.x - bounds.minX) <= epsilon && Math.abs(end.x - bounds.minX) <= epsilon) ||
    (Math.abs(start.x - bounds.maxX) <= epsilon && Math.abs(end.x - bounds.maxX) <= epsilon) ||
    (Math.abs(start.z - bounds.minZ) <= epsilon && Math.abs(end.z - bounds.minZ) <= epsilon) ||
    (Math.abs(start.z - bounds.maxZ) <= epsilon && Math.abs(end.z - bounds.maxZ) <= epsilon);
}

function undirectedEdgeKey(start: PlanningPoint, end: PlanningPoint): string {
  const pointKey = (point: PlanningPoint) =>
    `${Math.round(point.x * 1e6)},${Math.round(point.z * 1e6)}`;
  const first = pointKey(start);
  const second = pointKey(end);
  return first < second ? `${first}/${second}` : `${second}/${first}`;
}

/**
 * Street-lamp nodes are sparse in mapped data, so the plan keeps nearby mapped
 * lamps and fills the remaining lit road classes with deterministic road-side
 * placements. Lamps stand just beyond the planned road bed, alternating sides
 * so avenues do not read as rigidly mirrored boulevards. All lamps require a
 * building footprint within 50 meters.
 */
function planStreetLamps(
  roadInputs: readonly PlanningRoadInput[],
  lampInputs: readonly PlanningLampInput[],
  buildingSites: readonly PlannedBuildingSite[],
  roadBeds: readonly PlannedRoadPolygon[],
  bounds: RoadAndBuildingPlanBounds,
  options: RoadAndBuildingPlanningOptions,
): PlannedStreetLamp[] {
  if (buildingSites.length === 0) return [];
  const buildingDistance = LAMP_BUILDING_DISTANCE_METERS / options.metersPerUnit;
  const buildingIndex = new PlanarCellIndex<PlannedBuildingSite>(planningCellSize(options));
  for (const site of buildingSites) {
    buildingIndex.add(site, pointBounds(site.outline), buildingDistance);
  }
  const nearBuilding = (position: PlanningPoint): boolean =>
    buildingIndex.queryPoint(position).some((site) => {
      if (!pointInRing(position, site.outline)) {
        return distanceToRing(position, site.outline) <= buildingDistance;
      }
      const hole = site.holes.find((ring) => pointInRing(position, ring));
      return !hole || distanceToRing(position, hole) <= buildingDistance;
    });

  // Lamps stand clear of their own road, but near junctions the lateral
  // offset can land on a crossing road's bed; those spots are rejected.
  const bedClearance = 0.3 / options.metersPerUnit;
  const bedIndex = new PlanarCellIndex<PlannedRoadPolygon>(planningCellSize(options));
  for (const bed of roadBeds) {
    if (bed.structure === "bridge") continue;
    bedIndex.add(bed, pointBounds(bed.outline), bedClearance);
  }
  const onAnyRoadBed = (position: PlanningPoint): boolean =>
    bedIndex.queryPoint(position).some((bed) =>
      pointInRing(position, bed.outline) || distanceToRing(position, bed.outline) < bedClearance
    );

  const lamps: PlannedStreetLamp[] = [];
  const mapped: PlanningPoint[] = [];
  for (const lamp of lampInputs) {
    if (!insideBounds(lamp.position, bounds) || !nearBuilding(lamp.position)) continue;
    mapped.push(lamp.position);
    lamps.push({
      sourceId: lamp.id,
      position: lamp.position,
      orientationRadians: 0,
      source: "mapped",
    });
  }

  const spacing = LAMP_SPACING_METERS / options.metersPerUnit;
  const clearanceSquared = (MAPPED_LAMP_CLEARANCE_METERS / options.metersPerUnit) ** 2;
  for (const input of roadInputs) {
    const appearance = input.appearance;
    if (appearance.isTunnel || appearance.structure !== "surface") continue;
    if (!LAMP_ROAD_CLASSES.has(appearance.roadClass)) continue;
    const offset = (
      appearance.widthMeters / 2 + appearance.shoulderWidthMeters + LAMP_EDGE_MARGIN_METERS
    ) / options.metersPerUnit;
    for (const path of input.paths) {
      if (path.length < 2) continue;
      const phase = hashString(input.id) >>> 0;
      let distance = (phase % 1000) / 1000 * spacing;
      for (let index = 1; index < path.length; index++) {
        const start = path[index - 1];
        const end = path[index];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.hypot(dx, dz);
        if (length < 1e-8) continue;
        while (distance <= length) {
          const amount = distance / length;
          const side = ((Math.floor((distance + index * spacing) / spacing) + phase) & 1)
            ? 1 : -1;
          const position = {
            x: start.x + dx * amount - dz / length * offset * side,
            z: start.z + dz * amount + dx / length * offset * side,
          };
          if (insideBounds(position, bounds) && nearBuilding(position) && !onAnyRoadBed(position) && !mapped.some((lamp) =>
            (lamp.x - position.x) ** 2 + (lamp.z - position.z) ** 2 < clearanceSquared,
          )) {
            lamps.push({
              sourceId: input.id,
              position,
              orientationRadians: Math.atan2(dx, dz),
              source: "procedural",
            });
          }
          distance += spacing;
        }
        distance -= length;
      }
    }
  }
  return lamps;
}

/**
 * Grows one convex plot per building: the convex hull of the building site
 * offset outward, then cut flush against every nearby road bed edge, the
 * planning bounds, and the bisector toward each neighboring plot. The cuts
 * are all half-planes, so plots stay convex and neighboring plots share their
 * dividing boundary exactly — the attachment line for later hedges and fences.
 */
function planBuildingPlots(
  buildingSites: readonly PlannedBuildingSite[],
  roadCandidates: readonly Candidate[],
  bounds: RoadAndBuildingPlanBounds,
  options: RoadAndBuildingPlanningOptions,
): PlannedPlot[] {
  const depth = PLOT_DEPTH_METERS / options.metersPerUnit;
  const plots: Array<{
    sourceId: string;
    outline: PlanningPoint[];
    centroid: PlanningPoint;
    hull: PlanningPoint[];
  }> = [];
  for (const site of buildingSites) {
    const hull = convexHull(site.outline);
    if (hull.length < 3) continue;
    const outline = clipToBounds(offsetConvexPolygon(hull, depth), bounds);
    if (outline.length < 3) continue;
    plots.push({ sourceId: site.sourceId, outline, centroid: averagePoint(hull), hull });
  }

  const groundRoads = roadCandidates
    .filter((candidate) => candidate.structure !== "bridge")
    .map((candidate) => ({ candidate, bounds: pointBounds(candidate.outline) }));
  for (const plot of plots) {
    for (const { candidate, bounds: roadBounds } of groundRoads) {
      if (plot.outline.length < 3) break;
      const plotBounds = pointBounds(plot.outline);
      if (plotBounds.minX >= roadBounds.maxX || plotBounds.maxX <= roadBounds.minX ||
          plotBounds.minZ >= roadBounds.maxZ || plotBounds.maxZ <= roadBounds.minZ) continue;
      if (!polygonsOverlapArea(plot.outline, candidate.outline)) continue;
      const cut = roadEdgeLineTowards(candidate, plot.centroid, options);
      if (!cut) continue;
      plot.outline = clipHalfPlane(
        plot.outline,
        cut.a,
        cut.b,
        cross(cut.a, cut.b, plot.centroid) >= 0,
      );
    }
  }

  for (let left = 0; left < plots.length; left++) {
    for (let right = left + 1; right < plots.length; right++) {
      const first = plots[left];
      const second = plots[right];
      if (first.outline.length < 3 || second.outline.length < 3) continue;
      if (!boundsOverlap(first.outline, second.outline) ||
          !convexPolygonsOverlap(first.outline, second.outline)) continue;
      const bisector = plotBisector(first.hull, second.hull);
      if (!bisector) continue;
      first.outline = clipHalfPlane(
        first.outline,
        bisector.a,
        bisector.b,
        cross(bisector.a, bisector.b, first.centroid) >= 0,
      );
      second.outline = clipHalfPlane(
        second.outline,
        bisector.a,
        bisector.b,
        cross(bisector.a, bisector.b, second.centroid) >= 0,
      );
    }
  }

  return plots
    .filter((plot) => plot.outline.length >= 3 && polygonArea(plot.outline) > 1e-10)
    .map(({ sourceId, outline }) => ({ sourceId, outline }));
}

/** The road-bed edge facing the plot, as a half-plane cut line. */
function roadEdgeLineTowards(
  candidate: Candidate,
  towards: PlanningPoint,
  options: RoadAndBuildingPlanningOptions,
): { a: PlanningPoint; b: PlanningPoint } | undefined {
  const [start, end] = candidate.centerline;
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  if (length > 1e-8) {
    const outerHalfWidth = (
      candidate.widthMeters / 2 + candidate.shoulderWidthMeters
    ) / options.metersPerUnit;
    const nx = -dz / length;
    const nz = dx / length;
    const side = cross(start, end, towards) >= 0 ? 1 : -1;
    return {
      a: { x: start.x + nx * outerHalfWidth * side, z: start.z + nz * outerHalfWidth * side },
      b: { x: end.x + nx * outerHalfWidth * side, z: end.z + nz * outerHalfWidth * side },
    };
  }
  // Junction discs carry a degenerate centerline; cut along the tangent that
  // faces the plot instead of a strip edge.
  const radius = Math.max(...candidate.outline.map((point) =>
    Math.hypot(point.x - start.x, point.z - start.z)
  ));
  const towardsX = towards.x - start.x;
  const towardsZ = towards.z - start.z;
  const distance = Math.hypot(towardsX, towardsZ);
  if (distance <= radius + 1e-8) return undefined;
  const tangentPoint = {
    x: start.x + towardsX / distance * radius,
    z: start.z + towardsZ / distance * radius,
  };
  return {
    a: tangentPoint,
    b: { x: tangentPoint.x - towardsZ / distance, z: tangentPoint.z + towardsX / distance },
  };
}

/** Perpendicular bisector between the closest points of two building hulls. */
function plotBisector(
  first: readonly PlanningPoint[],
  second: readonly PlanningPoint[],
): { a: PlanningPoint; b: PlanningPoint } | undefined {
  const closest = closestPointsBetweenRings(first, second);
  let from = closest.onFirst;
  let to = closest.onSecond;
  if (closest.distance <= 1e-8) {
    // Touching or overlapping hulls: fall back to the centroid bisector.
    from = averagePoint(first);
    to = averagePoint(second);
    if (Math.hypot(to.x - from.x, to.z - from.z) <= 1e-8) return undefined;
  }
  const midpoint = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 };
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  const directionX = (to.x - from.x) / length;
  const directionZ = (to.z - from.z) / length;
  return {
    a: midpoint,
    b: { x: midpoint.x - directionZ, z: midpoint.z + directionX },
  };
}

function closestPointsBetweenRings(
  first: readonly PlanningPoint[],
  second: readonly PlanningPoint[],
): { onFirst: PlanningPoint; onSecond: PlanningPoint; distance: number } {
  let best = { onFirst: first[0], onSecond: second[0], distance: Infinity };
  const consider = (
    points: readonly PlanningPoint[],
    ring: readonly PlanningPoint[],
    pointsAreFirst: boolean,
  ) => {
    for (const point of points) {
      for (let index = 0; index < ring.length; index++) {
        const start = ring[index];
        const end = ring[(index + 1) % ring.length];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const lengthSquared = dx * dx + dz * dz;
        const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
          ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared
        ));
        const nearest = { x: start.x + dx * amount, z: start.z + dz * amount };
        const distance = Math.hypot(point.x - nearest.x, point.z - nearest.z);
        if (distance < best.distance) {
          best = pointsAreFirst
            ? { onFirst: point, onSecond: nearest, distance }
            : { onFirst: nearest, onSecond: point, distance };
        }
      }
    }
  };
  consider(first, second, true);
  consider(second, first, false);
  return best;
}

function insideBounds(point: PlanningPoint, bounds: RoadAndBuildingPlanBounds): boolean {
  return point.x >= bounds.minX && point.x <= bounds.maxX &&
    point.z >= bounds.minZ && point.z <= bounds.maxZ;
}

function triangulateCandidates(candidates: readonly Candidate[]): Candidate[] {
  return candidates.flatMap((candidate) => {
    if (candidate.outline.length === 3) return [candidate];
    const indices = earcut(candidate.outline.flatMap((point) => [point.x, point.z]));
    const triangles: Candidate[] = [];
    for (let index = 0; index < indices.length; index += 3) {
      triangles.push({
        ...candidate,
        outline: [
          candidate.outline[indices[index]],
          candidate.outline[indices[index + 1]],
          candidate.outline[indices[index + 2]],
        ],
      });
    }
    return triangles;
  });
}

/** Reassembles triangulation fragments after all overlap subtraction is done. */
function mergeCompatiblePolygons(roads: readonly PlannedRoadPolygon[]): PlannedRoadPolygon[] {
  const groups = new Map<string, PlannedRoadPolygon[]>();
  for (const road of roads) {
    const key = roadGeometryKey(road);
    const group = groups.get(key);
    if (group) group.push({ ...road, outline: [...road.outline] });
    else groups.set(key, [{ ...road, outline: [...road.outline] }]);
  }

  const result: PlannedRoadPolygon[] = [];
  for (const group of groups.values()) {
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let left = 0; left < group.length; left++) {
        for (let right = left + 1; right < group.length; right++) {
          const outline = mergeAlongSharedEdge(group[left].outline, group[right].outline);
          if (!outline) continue;
          group[left] = { ...group[left], outline };
          group.splice(right, 1);
          merged = true;
          break outer;
        }
      }
    }
    result.push(...group);
  }
  return result;
}

function roadGeometryKey(road: PlannedRoadPolygon): string {
  const point = ({ x, z }: PlanningPoint) => `${x},${z}`;
  return [
    road.sourceId,
    road.centerline.map(point).join("/"),
    road.textureAxis?.map(point).join("/") ?? "",
    road.startDistance,
    road.widthMeters,
    road.shoulderWidthMeters,
    road.visualStyle,
    road.surface,
    road.structure,
    road.layer,
  ].join("|");
}

function mergeAlongSharedEdge(
  first: readonly PlanningPoint[],
  second: readonly PlanningPoint[],
): PlanningPoint[] | undefined {
  for (let firstIndex = 0; firstIndex < first.length; firstIndex++) {
    const firstNext = (firstIndex + 1) % first.length;
    for (let secondIndex = 0; secondIndex < second.length; secondIndex++) {
      const secondNext = (secondIndex + 1) % second.length;
      if (!samePoint(first[firstIndex], second[secondNext]) ||
          !samePoint(first[firstNext], second[secondIndex])) continue;
      const firstBoundary = ringPath(first, firstNext, firstIndex);
      const secondBoundary = ringPath(second, secondNext, secondIndex);
      const outline = removeCollinearPoints([
        ...firstBoundary,
        ...secondBoundary.slice(1, -1),
      ]);
      return outline.length >= 3 ? outline : undefined;
    }
  }
  return undefined;
}

function ringPath(
  ring: readonly PlanningPoint[],
  start: number,
  end: number,
): PlanningPoint[] {
  const result: PlanningPoint[] = [];
  for (let index = start;; index = (index + 1) % ring.length) {
    result.push(ring[index]);
    if (index === end) return result;
  }
}

/** Splits centerlines at crossings so every approach ends on one shared, level junction. */
function buildRoadNetworkCandidates(
  roadInputs: readonly PlanningRoadInput[],
  options: RoadAndBuildingPlanningOptions,
): { surfaceCandidates: Candidate[]; outerCandidates: Candidate[] } {
  const segments: NetworkSegment[] = [];
  const nodeTolerance = Math.max(1e-7, 0.03 / options.metersPerUnit);
  const shared = sharedPathPoints(roadInputs, nodeTolerance);
  for (const input of roadInputs) {
    if (input.appearance.isTunnel) continue;
    const width = input.appearance.widthMeters / options.metersPerUnit;
    for (const source of input.paths) {
      const path = simplifyPath(source, width, width * SHAPE_DEVIATION_WIDTHS, (point) =>
        shared.has(pointKey(point, nodeTolerance)));
      let distance = 0;
      for (let index = 1; index < path.length; index++) {
        const start = path[index - 1];
        const end = path[index];
        const length = Math.hypot(end.x - start.x, end.z - start.z);
        if (length > 1e-8) segments.push({
          input,
          start,
          end,
          startDistance: distance,
          length,
          splits: [0, 1],
        });
        distance += length;
      }
    }
  }

  splitAtCrossings(segments, planningCellSize(options));
  const nodes = new Map<string, NetworkNode>();
  const pieces: NetworkPiece[] = [];
  const surfaceCandidates: Candidate[] = [];
  const outerCandidates: Candidate[] = [];
  for (const segment of segments) {
    const amounts = [...new Set(segment.splits.map((amount) => Math.round(amount * 1e9) / 1e9))]
      .sort((a, b) => a - b);
    for (let index = 1; index < amounts.length; index++) {
      const startAmount = amounts[index - 1];
      const endAmount = amounts[index];
      if (endAmount - startAmount <= 1e-8) continue;
      const start = interpolate(segment.start, segment.end, startAmount);
      const end = interpolate(segment.start, segment.end, endAmount);
      const startDistance = segment.startDistance + segment.length * startAmount;
      pieces.push({ input: segment.input, start, end, startDistance });
      addNetworkNode(
        nodes,
        start,
        segment.input,
        startDistance,
        [start, end],
        nodeTolerance,
        true,
      );
      addNetworkNode(
        nodes,
        end,
        segment.input,
        startDistance,
        [start, end],
        nodeTolerance,
        false,
      );
    }
  }

  for (const node of nodes.values()) {
    const winner = [...node.incidents].sort((a, b) =>
      roadPriority(b.input.appearance) - roadPriority(a.input.appearance)
    )[0];
    if (!winner) continue;
    const halfWidth = nodeRadius(node, options, false);
    const outerHalfWidth = nodeRadius(node, options, true);
    if (isBendNode(node)) {
      // A shape vertex inside one carriageway is not a junction. Filling only
      // the outer wedge with a mitered join keeps both approaches whole, where
      // a full junction disc swallows them on any curve sampled more finely
      // than the road is wide.
      addBendJoin(surfaceCandidates, node, halfWidth);
      addBendJoin(outerCandidates, node, outerHalfWidth);
      continue;
    }
    const common = candidateProperties(
      winner.input,
      node.point,
      node.point,
      winner.startDistance,
    );
    const oneSource = new Set(node.incidents.map(({ input }) => input.id)).size === 1;
    surfaceCandidates.push({
      ...common,
      textureAxis: winner.textureAxis,
      visualStyle: oneSource
        ? winner.input.appearance.visualStyle
        : junctionStyle(node.incidents.map(({ input }) => input.appearance)),
      outline: circlePolygon(node.point, halfWidth),
      priority: 1_000_000_000 + roadPriority(winner.input.appearance),
    });
    outerCandidates.push({
      ...common,
      outline: circlePolygon(node.point, outerHalfWidth),
      priority: 1_000_000_000 + roadPriority(winner.input.appearance),
    });
  }

  for (const piece of pieces) {
    const startNode = nodes.get(networkNodeKey(piece.input, piece.start, nodeTolerance));
    const endNode = nodes.get(networkNodeKey(piece.input, piece.end, nodeTolerance));
    if (!startNode || !endNode) continue;
    const halfWidth = piece.input.appearance.widthMeters / options.metersPerUnit / 2;
    const outerHalfWidth = halfWidth +
      piece.input.appearance.shoulderWidthMeters / options.metersPerUnit;
    const common = candidateProperties(piece.input, piece.start, piece.end, piece.startDistance);
    const startSurfaceRadius = trimRadius(startNode, options, false);
    const endSurfaceRadius = trimRadius(endNode, options, false);
    const startOuterRadius = trimRadius(startNode, options, true);
    const endOuterRadius = trimRadius(endNode, options, true);
    const surfaceOutline = approachPolygon(
      piece.start,
      piece.end,
      halfWidth,
      startSurfaceRadius,
      endSurfaceRadius,
    );
    const outerOutline = approachPolygon(
      piece.start,
      piece.end,
      outerHalfWidth,
      startOuterRadius,
      endOuterRadius,
    );
    const priority = roadPriority(piece.input.appearance);
    const length = Math.hypot(piece.end.x - piece.start.x, piece.end.z - piece.start.z);
    if (surfaceOutline.length >= 3) surfaceCandidates.push({
      ...common,
      gradeRange: gradeRange(
        length,
        { junction: startSurfaceRadius, interlock: halfWidth },
        { junction: endSurfaceRadius, interlock: halfWidth },
      ),
      outline: surfaceOutline,
      priority,
    });
    if (outerOutline.length >= 3) outerCandidates.push({
      ...common,
      gradeRange: gradeRange(
        length,
        { junction: startOuterRadius, interlock: outerHalfWidth },
        { junction: endOuterRadius, interlock: outerHalfWidth },
      ),
      outline: outerOutline,
      priority,
    });
  }
  return { surfaceCandidates, outerCandidates };
}

/**
 * Drops shape vertices packed closer together than the carriageway is wide.
 * A curve sampled that finely cannot be built from separate pieces: the
 * junction discs at either end consume whole pieces, and whatever grade is
 * left has to rise inside a sliver. The chord that replaces the dropped
 * vertices stays within a tenth of the road's width of the original line, so
 * roundabouts and sweeping bends keep their shape.
 */
function simplifyPath(
  path: ReadonlyArray<PlanningPoint>,
  minimumSpacing: number,
  maximumDeviation: number,
  isShared: (point: PlanningPoint) => boolean,
): PlanningPoint[] {
  if (path.length <= 2) return [...path];
  const result: PlanningPoint[] = [path[0]];
  let anchor = 0;
  for (let index = 1; index < path.length - 1; index++) {
    const spacing = Math.hypot(
      path[index].x - path[anchor].x,
      path[index].z - path[anchor].z,
    );
    const keep = spacing >= minimumSpacing ||
      isShared(path[index]) ||
      chordDeviation(path, anchor, index + 1) > maximumDeviation;
    if (!keep) continue;
    result.push(path[index]);
    anchor = index;
  }
  result.push(path[path.length - 1]);
  return result;
}

/**
 * Vertices more than one way passes through. Moving one of those would take a
 * side road's junction with it, so simplification has to leave them alone.
 */
function sharedPathPoints(
  roadInputs: readonly PlanningRoadInput[],
  tolerance: number,
): Set<string> {
  const owners = new Map<string, string>();
  const shared = new Set<string>();
  for (const input of roadInputs) {
    for (const path of input.paths) {
      for (const point of path) {
        const key = pointKey(point, tolerance);
        const owner = owners.get(key);
        if (owner === undefined) owners.set(key, input.id);
        else if (owner !== input.id) shared.add(key);
      }
    }
  }
  return shared;
}

function pointKey(point: PlanningPoint, tolerance: number): string {
  return `${Math.round(point.x / tolerance)}/${Math.round(point.z / tolerance)}`;
}

/** Furthest the vertices between two path indices stray from their chord. */
function chordDeviation(
  path: ReadonlyArray<PlanningPoint>,
  from: number,
  to: number,
): number {
  const start = path[from];
  const dx = path[to].x - start.x;
  const dz = path[to].z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  let deviation = 0;
  for (let index = from + 1; index < to; index++) {
    const point = path[index];
    const amount = lengthSquared <= 1e-12 ? 0 : Math.max(0, Math.min(1, (
      (point.x - start.x) * dx + (point.z - start.z) * dz
    ) / lengthSquared));
    deviation = Math.max(deviation, Math.hypot(
      point.x - (start.x + dx * amount),
      point.z - (start.z + dz * amount),
    ));
  }
  return deviation;
}

/** How far a simplified centerline may stray, as a share of the road width. */
const SHAPE_DEVIATION_WIDTHS = 0.1;

function splitAtCrossings(segments: NetworkSegment[], cellSize: number): void {
  // Each unordered pair is examined exactly once because a segment is only
  // indexed after it has been checked against everything indexed before it.
  const index = new PlanarCellIndex<NetworkSegment>(cellSize);
  for (const segment of segments) {
    const bounds = pointBounds([segment.start, segment.end]);
    const group = physicalLayerKey(segment.input.appearance);
    for (const candidate of index.query(bounds, 0, group)) {
      const crossing = segmentIntersection(candidate.start, candidate.end, segment.start, segment.end);
      if (!crossing) continue;
      candidate.splits.push(crossing.firstAmount);
      segment.splits.push(crossing.secondAmount);
    }
    index.add(segment, bounds, 0, group);
  }
}

function addNetworkNode(
  nodes: Map<string, NetworkNode>,
  point: PlanningPoint,
  input: PlanningRoadInput,
  startDistance: number,
  textureAxis: readonly [PlanningPoint, PlanningPoint],
  tolerance: number,
  atStart: boolean,
): void {
  const key = networkNodeKey(input, point, tolerance);
  const incident: NetworkIncident = {
    input,
    startDistance,
    textureAxis,
    atStart,
    length: Math.hypot(
      textureAxis[1].x - textureAxis[0].x,
      textureAxis[1].z - textureAxis[0].z,
    ),
  };
  const node = nodes.get(key);
  if (node) node.incidents.push(incident);
  else nodes.set(key, { point, incidents: [incident] });
}

function networkNodeKey(
  input: PlanningRoadInput,
  point: PlanningPoint,
  tolerance: number,
): string {
  return [
    physicalLayerKey(input.appearance),
    Math.round(point.x / tolerance),
    Math.round(point.z / tolerance),
  ].join("/");
}

/**
 * True when a node is only a shape vertex of one continuous carriageway:
 * exactly two pieces of identical appearance meet, so the road runs through.
 */
function isBendNode(node: NetworkNode): boolean {
  if (node.incidents.length !== 2) return false;
  const [first, second] = node.incidents;
  return roadAppearanceKey(first.input.appearance) ===
    roadAppearanceKey(second.input.appearance);
}

function roadAppearanceKey(appearance: RoadPlan): string {
  return [
    appearance.widthMeters,
    appearance.shoulderWidthMeters,
    appearance.visualStyle,
    appearance.surface,
    appearance.structure,
    appearance.layer,
  ].join("|");
}

/** How far an approach stops short of a node; a bend is run straight through. */
function trimRadius(
  node: NetworkNode,
  options: RoadAndBuildingPlanningOptions,
  includeShoulder: boolean,
): number {
  return isBendNode(node) ? 0 : nodeRadius(node, options, includeShoulder);
}

/**
 * Adds the wedge two square-ended approaches leave on the outside of a bend.
 * They already overlap on the inside, so this completes a mitered strip that
 * carries the road's own grade and texture direction instead of a disc that
 * has neither.
 */
function addBendJoin(
  candidates: Candidate[],
  node: NetworkNode,
  halfWidth: number,
): void {
  const ends = node.incidents.map((incident) => farEnd(node, incident));
  if (halfWidth <= 0 || !ends[0] || !ends[1]) return;
  const [from, to] = ends[0].distance <= ends[1].distance
    ? [ends[0], ends[1]]
    : [ends[1], ends[0]];
  const incoming = { x: -from.direction.x, z: -from.direction.z };
  const outgoing = to.direction;
  const turn = incoming.x * outgoing.z - incoming.z * outgoing.x;
  if (Math.abs(turn) <= 1e-9) return;
  const side = turn > 0 ? -1 : 1;
  const start = {
    x: node.point.x - side * halfWidth * incoming.z,
    z: node.point.z + side * halfWidth * incoming.x,
  };
  const end = {
    x: node.point.x - side * halfWidth * outgoing.z,
    z: node.point.z + side * halfWidth * outgoing.x,
  };
  const along = ((end.x - start.x) * outgoing.z - (end.z - start.z) * outgoing.x) / turn;
  const miter = { x: start.x + incoming.x * along, z: start.z + incoming.z * along };
  // A hairpin's miter spikes far past the carriageway, so bevel it instead.
  const corners = Math.hypot(miter.x - node.point.x, miter.z - node.point.z) >
      MAXIMUM_MITER_WIDTHS * halfWidth
    ? [node.point, start, end]
    : [node.point, start, miter, end];
  const outline = deduplicateRing(
    signedArea(corners) >= 0 ? corners : [...corners].reverse(),
  );
  if (outline.length < 3 || polygonArea(outline) <= 1e-10) return;
  candidates.push({
    // Both approaches read their shared end face as exactly the node's own
    // elevation, so a level wedge seams into them without a lip. The chord
    // through the bend is kept only to carry lane markings around the curve.
    ...candidateProperties(from.incident.input, node.point, node.point, from.distance),
    textureAxis: [from.point, to.point],
    outline,
    // Just below the approaches it completes, so a rounding overlap costs the
    // join rather than the carriageway.
    priority: roadPriority(from.incident.input.appearance) - 0.5,
  });
}

interface NetworkIncidentEnd {
  point: PlanningPoint;
  distance: number;
  direction: PlanningPoint;
  incident: NetworkIncident;
}

/** The end of an incident piece away from the node, with its path distance. */
function farEnd(
  node: NetworkNode,
  incident: NetworkIncident,
): NetworkIncidentEnd | undefined {
  const point = incident.atStart ? incident.textureAxis[1] : incident.textureAxis[0];
  const dx = point.x - node.point.x;
  const dz = point.z - node.point.z;
  const length = Math.hypot(dx, dz);
  if (length <= 1e-9) return undefined;
  return {
    point,
    distance: incident.atStart
      ? incident.startDistance + incident.length
      : incident.startDistance,
    direction: { x: dx / length, z: dz / length },
    incident,
  };
}

/** Beyond this the join is beveled, so a hairpin cannot grow a spike. */
const MAXIMUM_MITER_WIDTHS = 4;

function nodeRadius(
  node: NetworkNode,
  options: RoadAndBuildingPlanningOptions,
  includeShoulder: boolean,
): number {
  return Math.max(...node.incidents.map(({ input }) =>
    input.appearance.widthMeters / options.metersPerUnit / 2 +
    (includeShoulder ? input.appearance.shoulderWidthMeters / options.metersPerUnit : 0)
  ));
}

/** One polygon bounded by the circular junction arcs at both ends. */
function approachPolygon(
  start: PlanningPoint,
  end: PlanningPoint,
  halfWidth: number,
  startRadius: number,
  endRadius: number,
): PlanningPoint[] {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  if (length <= startRadius + endRadius + 1e-8) return [];
  const ux = dx / length;
  const uz = dz / length;
  const nx = -uz;
  const nz = ux;
  const startBoundary = junctionBoundary(
    start, ux, uz, nx, nz, halfWidth, startRadius, true,
  );
  const endBoundary = junctionBoundary(
    end, ux, uz, nx, nz, halfWidth, endRadius, false,
  ).reverse();
  return deduplicateRing([...startBoundary, ...endBoundary]);
}

/** Returns the exact chain on the regular junction polygon facing the approach. */
function junctionBoundary(
  center: PlanningPoint,
  ux: number,
  uz: number,
  nx: number,
  nz: number,
  halfWidth: number,
  radius: number,
  forward: boolean,
): PlanningPoint[] {
  if (radius <= 0) {
    return [
      { x: center.x + nx * halfWidth, z: center.z + nz * halfWidth },
      { x: center.x - nx * halfWidth, z: center.z - nz * halfWidth },
    ];
  }
  const vertices = circlePolygon(center, radius).map((point) => {
    const x = point.x - center.x;
    const z = point.z - center.z;
    return { longitudinal: x * ux + z * uz, lateral: x * nx + z * nz };
  });
  const laterals = [halfWidth, 0, -halfWidth];
  for (const vertex of vertices) {
    if (vertex.lateral < halfWidth - 1e-8 && vertex.lateral > -halfWidth + 1e-8) {
      laterals.push(vertex.lateral);
    }
  }
  laterals.sort((a, b) => b - a);
  const result: PlanningPoint[] = [];
  for (const lateral of [...new Set(laterals.map((value) => Math.round(value * 1e9) / 1e9))]) {
    const intersections: number[] = [];
    for (let index = 0; index < vertices.length; index++) {
      const a = vertices[index];
      const b = vertices[(index + 1) % vertices.length];
      if (Math.abs(a.lateral - lateral) <= 1e-8) intersections.push(a.longitudinal);
      if ((a.lateral < lateral) === (b.lateral < lateral)) continue;
      const amount = (lateral - a.lateral) / (b.lateral - a.lateral);
      intersections.push(a.longitudinal + (b.longitudinal - a.longitudinal) * amount);
    }
    if (intersections.length === 0) continue;
    const longitudinal = forward ? Math.max(...intersections) : Math.min(...intersections);
    result.push({
      x: center.x + ux * longitudinal + nx * lateral,
      z: center.z + uz * longitudinal + nz * lateral,
    });
  }
  return result;
}

function roadPriority(appearance: RoadPlan): number {
  const classPriority: Readonly<Record<string, number>> = {
    motorway: 9, trunk: 8, primary: 7, secondary: 6, tertiary: 5,
    minor: 4, service: 3, track: 2, path: 1,
  };
  return appearance.widthMeters * 1_000 + (classPriority[appearance.roadClass] ?? 0);
}

function junctionStyle(appearances: readonly RoadPlan[]): RoadVisualStyle {
  if (appearances.some((appearance) => appearance.visualStyle === "ford")) return "ford";
  if (appearances.every((appearance) => appearance.visualStyle === "dirt")) return "dirt";
  if (appearances.every((appearance) => appearance.visualStyle === "unpaved")) return "unpaved";
  if (appearances.every((appearance) => appearance.visualStyle === "pedestrian")) return "pedestrian";
  return "paved";
}

function interpolate(start: PlanningPoint, end: PlanningPoint, amount: number): PlanningPoint {
  return {
    x: start.x + (end.x - start.x) * amount,
    z: start.z + (end.z - start.z) * amount,
  };
}

function candidateProperties(
  input: PlanningRoadInput,
  start: PlanningPoint,
  end: PlanningPoint,
  startDistance: number,
): Omit<Candidate, "outline" | "priority"> {
  return {
    sourceId: input.id,
    centerline: [start, end],
    gradeRange: [0, 1],
    startDistance,
    widthMeters: input.appearance.widthMeters,
    shoulderWidthMeters: input.appearance.shoulderWidthMeters,
    visualStyle: input.appearance.visualStyle,
    surface: input.appearance.surface,
    structure: input.appearance.structure,
    layer: input.appearance.layer,
  };
}

/**
 * Where a point sits along a carriageway's grade, from 0 at the low end to 1
 * at the high end. Points beyond the ramp are level with the junction there.
 */
export function roadGradeAmount(
  road: Pick<PlannedRoadPolygon, "centerline" | "gradeRange">,
  point: PlanarPoint,
): number {
  const dx = road.centerline[1].x - road.centerline[0].x;
  const dz = road.centerline[1].z - road.centerline[0].z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 1e-12) return 0;
  const along = (
    (point.x - road.centerline[0].x) * dx + (point.z - road.centerline[0].z) * dz
  ) / lengthSquared;
  const [from, to] = road.gradeRange;
  if (to - from <= 1e-9) return 0;
  return Math.max(0, Math.min(1, (along - from) / (to - from)));
}

/** How far either end of a piece wants to stay level with what it meets. */
interface GradeEnd {
  /** Radius of the junction disc there, which must be level with the road. */
  junction: number;
  /** How far the neighbouring piece reaches around the shared node. */
  interlock: number;
}

/**
 * The span of a piece over which its grade rises.
 *
 * Two pieces meeting at a bend overlap in a wedge as deep as the road is
 * wide, and whichever of them the partition hands that wedge to decides where
 * the seam falls. Holding both ends level over that depth makes every point in
 * the wedge read the shared node's own height, so the seam cannot leave a lip
 * wherever it lands. A junction disc is level by construction and so is
 * honoured first; the interlock only takes what is left after the ramp keeps a
 * minimum run, which is what stops a short piece from rising like a step.
 */
function gradeRange(
  length: number,
  start: GradeEnd,
  end: GradeEnd,
): readonly [number, number] {
  if (length <= 1e-9) return [0, 1];
  const from = Math.min(1, start.junction / length);
  const to = Math.max(from, 1 - end.junction / length);
  const room = to - from;
  if (room <= 1e-6) return [0, 1];
  const wantedFrom = Math.max(0, start.interlock - start.junction) / length;
  const wantedTo = Math.max(0, end.interlock - end.junction) / length;
  const wanted = wantedFrom + wantedTo;
  const spare = Math.max(0, room - MINIMUM_RAMP_SHARE);
  const share = wanted <= 1e-9 ? 0 : Math.min(1, spare / wanted);
  return [from + wantedFrom * share, to - wantedTo * share];
}

/** Shortest run, as a share of a piece, the grade may rise over. */
const MINIMUM_RAMP_SHARE = 0.4;

function partitionCandidates(
  candidates: readonly Candidate[],
  bounds: PlanarBounds,
  options: RoadAndBuildingPlanningOptions,
): PlannedRoadPolygon[] {
  const accepted: PlannedRoadPolygon[] = [];
  const index = new PlanarCellIndex<PlannedRoadPolygon>(planningCellSize(options));
  for (const candidate of [...candidates].sort((a, b) => b.priority - a.priority)) {
    let pieces = [clipToBounds(candidate.outline, bounds)];
    const overlaps = index.query(pointBounds(candidate.outline), 0, physicalLayerKey(candidate));
    for (const previous of overlaps) {
      pieces = pieces.flatMap((piece) => boundsOverlap(piece, previous.outline)
        && polygonsOverlapArea(piece, previous.outline)
        ? subtractConvex(piece, previous.outline)
        : [piece]);
      if (pieces.length === 0) break;
    }
    for (const outline of pieces) {
      if (polygonArea(outline) <= 1e-10) continue;
      const road = { ...candidate, outline };
      accepted.push(road);
      index.add(road, pointBounds(outline), 0, physicalLayerKey(road));
    }
  }
  return accepted;
}

/** Cell size shared by every planning spatial index: roughly 20 meters. */
function planningCellSize(options: RoadAndBuildingPlanningOptions): number {
  return Math.max(0.25, 20 / options.metersPerUnit);
}

function physicalLayerKey(road: Pick<PlannedRoadPolygon, "layer" | "structure">): string {
  // Fords occupy the same ground plane as ordinary surface roads. Bridges
  // retain a separate plane so a genuine overpass may overlap horizontally.
  return `${road.layer}/${road.structure === "bridge" ? "bridge" : "ground"}`;
}

function circlePolygon(center: PlanningPoint, radius: number): PlanningPoint[] {
  if (radius <= 0) return [];
  return Array.from({ length: 12 }, (_, index) => {
    const angle = index / 12 * Math.PI * 2;
    return { x: center.x + Math.cos(angle) * radius, z: center.z + Math.sin(angle) * radius };
  });
}
