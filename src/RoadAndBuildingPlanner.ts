import type { RoadPlan, RoadSurface, RoadVisualStyle } from "./RoadPlanner";
import earcut from "earcut";

export interface PlanningPoint {
  x: number;
  z: number;
}

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

export interface RoadAndBuildingPlan {
  /** Mutually exclusive carriageway polygons within each physical road layer. */
  roads: PlannedRoadPolygon[];
  /** Mutually exclusive outer road beds; carriageways render above them. */
  shoulders: PlannedRoadPolygon[];
  buildingSites: PlannedBuildingSite[];
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

interface NetworkNode {
  point: PlanningPoint;
  incidents: Array<{
    input: PlanningRoadInput;
    startDistance: number;
    textureAxis: readonly [PlanningPoint, PlanningPoint];
  }>;
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

  const planningCellSize = Math.max(0.25, 20 / options.metersPerUnit);
  const roads = partitionCandidates(
    triangulateCandidates(surfaceCandidates),
    bounds,
    planningCellSize,
  );
  const shoulders = partitionCandidates(
    triangulateCandidates(outerCandidates),
    bounds,
    planningCellSize,
  );
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

  return { roads, shoulders, buildingSites };
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

/** Splits centerlines at crossings so every approach ends on one shared, level junction. */
function buildRoadNetworkCandidates(
  roadInputs: readonly PlanningRoadInput[],
  options: RoadAndBuildingPlanningOptions,
): { surfaceCandidates: Candidate[]; outerCandidates: Candidate[] } {
  const segments: NetworkSegment[] = [];
  for (const input of roadInputs) {
    if (input.appearance.isTunnel) continue;
    for (const path of input.paths) {
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

  splitAtCrossings(segments, Math.max(0.25, 20 / options.metersPerUnit));
  const nodeTolerance = Math.max(1e-7, 0.03 / options.metersPerUnit);
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
      addNetworkNode(nodes, start, segment.input, startDistance, [start, end], nodeTolerance);
      addNetworkNode(
        nodes,
        end,
        segment.input,
        startDistance,
        [start, end],
        nodeTolerance,
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
    const startSurfaceRadius = nodeRadius(startNode, options, false);
    const endSurfaceRadius = nodeRadius(endNode, options, false);
    const startOuterRadius = nodeRadius(startNode, options, true);
    const endOuterRadius = nodeRadius(endNode, options, true);
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
    if (surfaceOutline.length >= 3) surfaceCandidates.push({
      ...common,
      outline: surfaceOutline,
      priority,
    });
    if (outerOutline.length >= 3) outerCandidates.push({
      ...common,
      outline: outerOutline,
      priority,
    });
  }
  return { surfaceCandidates, outerCandidates };
}

function splitAtCrossings(segments: NetworkSegment[], cellSize: number): void {
  const cells = new Map<string, NetworkSegment[]>();
  const checked = new Set<string>();
  const ids = new Map(segments.map((segment, index) => [segment, index]));
  for (const segment of segments) {
    const bounds = pointBounds([segment.start, segment.end]);
    const candidates = new Set<NetworkSegment>();
    for (let z = Math.floor(bounds.minZ / cellSize); z <= Math.floor(bounds.maxZ / cellSize); z++) {
      for (let x = Math.floor(bounds.minX / cellSize); x <= Math.floor(bounds.maxX / cellSize); x++) {
        const key = `${physicalLayerKey(segment.input.appearance)}/${x}/${z}`;
        for (const candidate of cells.get(key) ?? []) candidates.add(candidate);
      }
    }
    for (const candidate of candidates) {
      const pairKey = `${ids.get(candidate)}/${ids.get(segment)}`;
      if (checked.has(pairKey)) continue;
      checked.add(pairKey);
      const crossing = segmentIntersection(candidate.start, candidate.end, segment.start, segment.end);
      if (!crossing) continue;
      candidate.splits.push(crossing.firstAmount);
      segment.splits.push(crossing.secondAmount);
    }
    for (let z = Math.floor(bounds.minZ / cellSize); z <= Math.floor(bounds.maxZ / cellSize); z++) {
      for (let x = Math.floor(bounds.minX / cellSize); x <= Math.floor(bounds.maxX / cellSize); x++) {
        const key = `${physicalLayerKey(segment.input.appearance)}/${x}/${z}`;
        const cell = cells.get(key);
        if (cell) cell.push(segment);
        else cells.set(key, [segment]);
      }
    }
  }
}

function segmentIntersection(
  a: PlanningPoint,
  b: PlanningPoint,
  c: PlanningPoint,
  d: PlanningPoint,
): { firstAmount: number; secondAmount: number } | undefined {
  const adx = b.x - a.x;
  const adz = b.z - a.z;
  const bdx = d.x - c.x;
  const bdz = d.z - c.z;
  const denominator = adx * bdz - adz * bdx;
  if (Math.abs(denominator) <= 1e-10) return undefined;
  const ox = c.x - a.x;
  const oz = c.z - a.z;
  const firstAmount = (ox * bdz - oz * bdx) / denominator;
  const secondAmount = (ox * adz - oz * adx) / denominator;
  const epsilon = 1e-7;
  if (firstAmount < -epsilon || firstAmount > 1 + epsilon ||
      secondAmount < -epsilon || secondAmount > 1 + epsilon) return undefined;
  return {
    firstAmount: Math.max(0, Math.min(1, firstAmount)),
    secondAmount: Math.max(0, Math.min(1, secondAmount)),
  };
}

function addNetworkNode(
  nodes: Map<string, NetworkNode>,
  point: PlanningPoint,
  input: PlanningRoadInput,
  startDistance: number,
  textureAxis: readonly [PlanningPoint, PlanningPoint],
  tolerance: number,
): void {
  const key = networkNodeKey(input, point, tolerance);
  const node = nodes.get(key);
  if (node) node.incidents.push({ input, startDistance, textureAxis });
  else nodes.set(key, { point, incidents: [{ input, startDistance, textureAxis }] });
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
  return deduplicate([...startBoundary, ...endBoundary]);
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
    startDistance,
    widthMeters: input.appearance.widthMeters,
    shoulderWidthMeters: input.appearance.shoulderWidthMeters,
    visualStyle: input.appearance.visualStyle,
    surface: input.appearance.surface,
    structure: input.appearance.structure,
    layer: input.appearance.layer,
  };
}

function partitionCandidates(
  candidates: readonly Candidate[],
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  cellSize: number,
): PlannedRoadPolygon[] {
  const accepted: PlannedRoadPolygon[] = [];
  const index = new Map<string, Set<PlannedRoadPolygon>>();
  for (const candidate of [...candidates].sort((a, b) => b.priority - a.priority)) {
    let pieces = [clipToBounds(candidate.outline, bounds)];
    for (const previous of indexedOverlaps(candidate, index, cellSize)) {
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
      addToPolygonIndex(road, index, cellSize);
    }
  }
  return accepted;
}

function physicalLayerKey(road: Pick<PlannedRoadPolygon, "layer" | "structure">): string {
  // Fords occupy the same ground plane as ordinary surface roads. Bridges
  // retain a separate plane so a genuine overpass may overlap horizontally.
  return `${road.layer}/${road.structure === "bridge" ? "bridge" : "ground"}`;
}

function addToPolygonIndex(
  road: PlannedRoadPolygon,
  index: Map<string, Set<PlannedRoadPolygon>>,
  cellSize: number,
): void {
  for (const key of polygonCellKeys(road, cellSize)) {
    const cell = index.get(key);
    if (cell) cell.add(road);
    else index.set(key, new Set([road]));
  }
}

function indexedOverlaps(
  road: PlannedRoadPolygon,
  index: ReadonlyMap<string, ReadonlySet<PlannedRoadPolygon>>,
  cellSize: number,
): PlannedRoadPolygon[] {
  const result = new Set<PlannedRoadPolygon>();
  for (const key of polygonCellKeys(road, cellSize)) {
    for (const candidate of index.get(key) ?? []) result.add(candidate);
  }
  return [...result];
}

function polygonCellKeys(road: PlannedRoadPolygon, cellSize: number): string[] {
  const bounds = pointBounds(road.outline);
  const keys: string[] = [];
  for (let z = Math.floor(bounds.minZ / cellSize); z <= Math.floor(bounds.maxZ / cellSize); z++) {
    for (let x = Math.floor(bounds.minX / cellSize); x <= Math.floor(bounds.maxX / cellSize); x++) {
      keys.push(`${physicalLayerKey(road)}/${x}/${z}`);
    }
  }
  return keys;
}

function circlePolygon(center: PlanningPoint, radius: number): PlanningPoint[] {
  if (radius <= 0) return [];
  return Array.from({ length: 12 }, (_, index) => {
    const angle = index / 12 * Math.PI * 2;
    return { x: center.x + Math.cos(angle) * radius, z: center.z + Math.sin(angle) * radius };
  });
}

/** Partitions subject-minus-clip into non-overlapping convex polygons. */
function subtractConvex(subject: readonly PlanningPoint[], clip: readonly PlanningPoint[]): PlanningPoint[][] {
  if (subject.length < 3 || clip.length < 3) return subject.length >= 3 ? [[...subject]] : [];
  const ccwClip = signedArea(clip) >= 0 ? clip : [...clip].reverse();
  let inside = [...subject];
  const outside: PlanningPoint[][] = [];
  for (let index = 0; index < ccwClip.length && inside.length >= 3; index++) {
    const a = ccwClip[index];
    const b = ccwClip[(index + 1) % ccwClip.length];
    const removed = clipHalfPlane(inside, a, b, false);
    if (removed.length >= 3) outside.push(removed);
    inside = clipHalfPlane(inside, a, b, true);
  }
  return outside;
}

function clipHalfPlane(
  polygon: readonly PlanningPoint[],
  a: PlanningPoint,
  b: PlanningPoint,
  keepLeft: boolean,
): PlanningPoint[] {
  const result: PlanningPoint[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index];
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const currentSide = cross(a, b, current);
    const previousSide = cross(a, b, previous);
    const currentInside = keepLeft ? currentSide >= -1e-9 : currentSide <= 1e-9;
    const previousInside = keepLeft ? previousSide >= -1e-9 : previousSide <= 1e-9;
    if (currentInside !== previousInside) {
      const amount = previousSide / (previousSide - currentSide);
      result.push({
        x: previous.x + (current.x - previous.x) * amount,
        z: previous.z + (current.z - previous.z) * amount,
      });
    }
    if (currentInside) result.push(current);
  }
  return deduplicate(result);
}

function clipToBounds(
  polygon: readonly PlanningPoint[],
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): PlanningPoint[] {
  let result = [...polygon];
  const edges: Array<[PlanningPoint, PlanningPoint]> = [
    [{ x: bounds.minX, z: bounds.minZ }, { x: bounds.maxX, z: bounds.minZ }],
    [{ x: bounds.maxX, z: bounds.minZ }, { x: bounds.maxX, z: bounds.maxZ }],
    [{ x: bounds.maxX, z: bounds.maxZ }, { x: bounds.minX, z: bounds.maxZ }],
    [{ x: bounds.minX, z: bounds.maxZ }, { x: bounds.minX, z: bounds.minZ }],
  ];
  for (const [a, b] of edges) result = clipHalfPlane(result, a, b, true);
  return result;
}

function cross(a: PlanningPoint, b: PlanningPoint, p: PlanningPoint): number {
  return (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
}

function signedArea(points: readonly PlanningPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    twiceArea += points[index].x * next.z - next.x * points[index].z;
  }
  return twiceArea / 2;
}

function polygonArea(points: readonly PlanningPoint[]): number {
  return Math.abs(signedArea(points));
}

function boundsOverlap(a: readonly PlanningPoint[], b: readonly PlanningPoint[]): boolean {
  const left = pointBounds(a);
  const right = pointBounds(b);
  return left.minX < right.maxX - 1e-9 && left.maxX > right.minX + 1e-9 &&
    left.minZ < right.maxZ - 1e-9 && left.maxZ > right.minZ + 1e-9;
}

function polygonsOverlapArea(
  a: readonly PlanningPoint[],
  b: readonly PlanningPoint[],
): boolean {
  const epsilon = 1e-8;
  const cross = (p: PlanningPoint, q: PlanningPoint, r: PlanningPoint) =>
    (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  for (let ai = 0; ai < a.length; ai++) {
    const a1 = a[ai];
    const a2 = a[(ai + 1) % a.length];
    for (let bi = 0; bi < b.length; bi++) {
      const b1 = b[bi];
      const b2 = b[(bi + 1) % b.length];
      if (cross(a1, a2, b1) * cross(a1, a2, b2) < -epsilon &&
          cross(b1, b2, a1) * cross(b1, b2, a2) < -epsilon) return true;
    }
  }
  const strictlyInside = (point: PlanningPoint, polygon: readonly PlanningPoint[]) =>
    pointInRing(point, polygon) && distanceToRing(point, polygon) > epsilon;
  if (a.some((point) => strictlyInside(point, b)) ||
      b.some((point) => strictlyInside(point, a))) return true;
  return strictlyInside(averagePoint(a), b) || strictlyInside(averagePoint(b), a);
}

function pointInRing(point: PlanningPoint, polygon: readonly PlanningPoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    if ((a.z > point.z) !== (b.z > point.z) &&
        point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function distanceToRing(point: PlanningPoint, polygon: readonly PlanningPoint[]): number {
  let distance = Infinity;
  for (let index = 0; index < polygon.length; index++) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
      ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared
    ));
    distance = Math.min(distance, Math.hypot(
      point.x - start.x - dx * amount,
      point.z - start.z - dz * amount,
    ));
  }
  return distance;
}

function averagePoint(points: readonly PlanningPoint[]): PlanningPoint {
  const sum = points.reduce((result, point) => ({
    x: result.x + point.x,
    z: result.z + point.z,
  }), { x: 0, z: 0 });
  return { x: sum.x / points.length, z: sum.z / points.length };
}

function pointBounds(points: readonly PlanningPoint[]): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  return points.reduce((result, point) => ({
    minX: Math.min(result.minX, point.x),
    maxX: Math.max(result.maxX, point.x),
    minZ: Math.min(result.minZ, point.z),
    maxZ: Math.max(result.maxZ, point.z),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
}

function deduplicate(points: readonly PlanningPoint[]): PlanningPoint[] {
  const result: PlanningPoint[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.z - previous.z) > 1e-8) result.push(point);
  }
  if (result.length > 1 && Math.hypot(
    result[0].x - result[result.length - 1].x,
    result[0].z - result[result.length - 1].z,
  ) <= 1e-8) result.pop();
  return result;
}

function withoutClosingPoint(points: ReadonlyArray<PlanningPoint>): PlanningPoint[] {
  if (points.length < 2) return [...points];
  const first = points[0];
  const last = points[points.length - 1];
  return Math.hypot(first.x - last.x, first.z - last.z) <= 1e-8
    ? points.slice(0, -1)
    : [...points];
}
