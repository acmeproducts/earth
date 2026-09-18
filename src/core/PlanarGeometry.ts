import { pointInPolygon, ringEdges } from "./Geometry2D";
/**
 * The project's shared 2D polygon math for scene-space (x/z) geometry.
 *
 * Planning, terrain conforming, map meshing, and procedural building layers
 * all reason about the same horizontal plane. Keeping the primitives in one
 * file is what keeps their results consistent: a second point-in-polygon or
 * clipper with a different epsilon silently disagrees about the same boundary,
 * and the divergence only ever shows up as a seam nobody can attribute.
 */

export interface PlanarPoint {
  x: number;
  z: number;
}

export interface PlanarBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function segmentVector(start: PlanarPoint, end: PlanarPoint) {
  const dx = end.x - start.x, dz = end.z - start.z;
  return { dx, dz, length: Math.hypot(dx, dz) };
}

export function cross(a: PlanarPoint, b: PlanarPoint, p: PlanarPoint): number {
  return (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
}

export function signedArea(points: readonly PlanarPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    twiceArea += points[index].x * next.z - next.x * points[index].z;
  }
  return twiceArea / 2;
}

export function polygonArea(points: readonly PlanarPoint[]): number {
  return Math.abs(signedArea(points));
}

export function averagePoint(points: readonly PlanarPoint[]): PlanarPoint {
  const sum = points.reduce((result, point) => ({
    x: result.x + point.x,
    z: result.z + point.z,
  }), { x: 0, z: 0 });
  return { x: sum.x / points.length, z: sum.z / points.length };
}

export function pointBounds(points: readonly PlanarPoint[]): PlanarBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }
  return { minX, maxX, minZ, maxZ };
}

export function boundsOverlap(a: readonly PlanarPoint[], b: readonly PlanarPoint[]): boolean {
  const left = pointBounds(a);
  const right = pointBounds(b);
  return left.minX < right.maxX - 1e-9 && left.maxX > right.minX + 1e-9 &&
    left.minZ < right.maxZ - 1e-9 && left.maxZ > right.minZ + 1e-9;
}

export function samePoint(first: PlanarPoint, second: PlanarPoint): boolean {
  const dx = first.x - second.x;
  const dz = first.z - second.z;
  return dx * dx + dz * dz <= 1e-16;
}

/** Axis-aligned bounds overlap with the same tolerance as boundsOverlap. */
export function boundsIntersect(left: PlanarBounds, right: PlanarBounds): boolean {
  return left.minX < right.maxX - 1e-9 && left.maxX > right.minX + 1e-9 &&
    left.minZ < right.maxZ - 1e-9 && left.maxZ > right.minZ + 1e-9;
}

export function pointInRing(point: PlanarPoint, polygon: readonly PlanarPoint[]): boolean {
  return pointInPolygon(point.x, point.z, polygon, p => p.x, p => p.z);
}

export function distanceToRing(point: PlanarPoint, polygon: readonly PlanarPoint[]): number {
  let distance = Infinity;
  for (const [start, end] of ringEdges(polygon)) {
    const nearest = closestPointOnSegment(point, start, end);
    distance = Math.min(distance, Math.hypot(point.x - nearest.x, point.z - nearest.z));
  }
  return distance;
}

/** Drops consecutive duplicates and a closing point that repeats the start. */
export function deduplicateRing(points: readonly PlanarPoint[]): PlanarPoint[] {
  const result: PlanarPoint[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous || !samePoint(point, previous)) result.push(point);
  }
  if (result.length > 1 && samePoint(result[0], result[result.length - 1])) result.pop();
  return result;
}

export function withoutClosingPoint(points: readonly PlanarPoint[]): PlanarPoint[] {
  if (points.length < 2) return [...points];
  const first = points[0];
  const last = points[points.length - 1];
  return Math.hypot(first.x - last.x, first.z - last.z) <= 1e-8
    ? points.slice(0, -1)
    : [...points];
}

export function removeCollinearPoints(points: readonly PlanarPoint[]): PlanarPoint[] {
  let result = deduplicateRing(points);
  let changed = true;
  while (changed && result.length > 3) {
    changed = false;
    for (let index = 0; index < result.length; index++) {
      const previous = result[(index + result.length - 1) % result.length];
      const current = result[index];
      const next = result[(index + 1) % result.length];
      if (Math.abs(cross(previous, current, next)) > 1e-9) continue;
      result = [...result.slice(0, index), ...result.slice(index + 1)];
      changed = true;
      break;
    }
  }
  return result;
}

export function clipHalfPlane(
  polygon: readonly PlanarPoint[],
  a: PlanarPoint,
  b: PlanarPoint,
  keepLeft: boolean,
): PlanarPoint[] {
  const result: PlanarPoint[] = [];
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
  return deduplicateRing(result);
}

export function clipToBounds(
  polygon: readonly PlanarPoint[],
  bounds: PlanarBounds,
): PlanarPoint[] {
  // Most pieces lie fully inside the tile; skip four half-plane passes then.
  let inside = true;
  for (const point of polygon) {
    if (point.x < bounds.minX || point.x > bounds.maxX || point.z < bounds.minZ || point.z > bounds.maxZ) {
      inside = false;
      break;
    }
  }
  if (inside) {
    const deduplicated = deduplicateRing(polygon);
    return deduplicated.length === polygon.length ? (polygon as PlanarPoint[]) : deduplicated;
  }
  let result = [...polygon];
  const edges: Array<[PlanarPoint, PlanarPoint]> = [
    [{ x: bounds.minX, z: bounds.minZ }, { x: bounds.maxX, z: bounds.minZ }],
    [{ x: bounds.maxX, z: bounds.minZ }, { x: bounds.maxX, z: bounds.maxZ }],
    [{ x: bounds.maxX, z: bounds.maxZ }, { x: bounds.minX, z: bounds.maxZ }],
    [{ x: bounds.minX, z: bounds.maxZ }, { x: bounds.minX, z: bounds.minZ }],
  ];
  for (const [a, b] of edges) result = clipHalfPlane(result, a, b, true);
  return result;
}

export function segmentIntersection(
  a: PlanarPoint,
  b: PlanarPoint,
  c: PlanarPoint,
  d: PlanarPoint,
): { firstAmount: number; secondAmount: number } | undefined {
  const { dx: adx, dz: adz } = segmentVector(a, b);
  const { dx: bdx, dz: bdz } = segmentVector(c, d);
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

/** Conservative positive-area overlap test for arbitrary simple polygons. */
export function polygonsOverlapArea(
  a: readonly PlanarPoint[],
  b: readonly PlanarPoint[],
): boolean {
  const epsilon = 1e-8;
  for (const [a1, a2] of ringEdges(a)) {
    for (const [b1, b2] of ringEdges(b)) {
      if (cross(a1, a2, b1) * cross(a1, a2, b2) < -epsilon &&
          cross(b1, b2, a1) * cross(b1, b2, a2) < -epsilon) return true;
    }
  }
  const strictlyInside = (point: PlanarPoint, polygon: readonly PlanarPoint[]) =>
    pointInRing(point, polygon) && distanceToRing(point, polygon) > epsilon;
  if (a.some((point) => strictlyInside(point, b)) ||
      b.some((point) => strictlyInside(point, a))) return true;
  return strictlyInside(averagePoint(a), b) || strictlyInside(averagePoint(b), a);
}

/** Exact separating-axis test; merely touching polygons do not overlap. */
export function convexPolygonsOverlap(
  first: readonly PlanarPoint[],
  second: readonly PlanarPoint[],
): boolean {
  for (const ring of [first, second]) {
    for (const [start, end] of ringEdges(ring)) {
      const axisX = end.z - start.z;
      const axisZ = start.x - end.x;
      const project = (points: readonly PlanarPoint[]) => {
        let min = Infinity;
        let max = -Infinity;
        for (const point of points) {
          const value = point.x * axisX + point.z * axisZ;
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
        return { min, max };
      };
      const firstRange = project(first);
      const secondRange = project(second);
      const scale = Math.hypot(axisX, axisZ);
      if (scale <= 1e-12) continue;
      if (Math.min(firstRange.max, secondRange.max) -
          Math.max(firstRange.min, secondRange.min) <= 1e-9 * scale) return false;
    }
  }
  return true;
}

/** Partitions subject-minus-clip into non-overlapping convex polygons. */
export function subtractConvex(
  subject: readonly PlanarPoint[],
  clip: readonly PlanarPoint[],
): PlanarPoint[][] {
  if (subject.length < 3 || clip.length < 3) return subject.length >= 3 ? [[...subject]] : [];
  const ccwClip = signedArea(clip) >= 0 ? clip : [...clip].reverse();
  let inside = [...subject];
  const outside: PlanarPoint[][] = [];
  for (let index = 0; index < ccwClip.length && inside.length >= 3; index++) {
    const a = ccwClip[index];
    const b = ccwClip[(index + 1) % ccwClip.length];
    const removed = clipHalfPlane(inside, a, b, false);
    if (removed.length >= 3) outside.push(removed);
    inside = clipHalfPlane(inside, a, b, true);
  }
  return outside;
}

export function convexHull(points: readonly PlanarPoint[]): PlanarPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  if (sorted.length < 3) return [];
  const half = (input: readonly PlanarPoint[]) => {
    const chain: PlanarPoint[] = [];
    for (const point of input) {
      while (chain.length >= 2 &&
        cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 1e-12) chain.pop();
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** Miter-offsets a convex ring outward, beveling corners too sharp to miter. */
export function offsetConvexPolygon(ring: readonly PlanarPoint[], depth: number): PlanarPoint[] {
  const ccw = signedArea(ring) >= 0 ? [...ring] : [...ring].reverse();
  const normals = ccw.map((point, index) => {
    const next = ccw[(index + 1) % ccw.length];
    const length = Math.hypot(next.x - point.x, next.z - point.z);
    return length <= 1e-12
      ? { x: 0, z: 0 }
      : { x: (next.z - point.z) / length, z: -(next.x - point.x) / length };
  });
  const result: PlanarPoint[] = [];
  for (let index = 0; index < ccw.length; index++) {
    const vertex = ccw[index];
    const incoming = normals[(index + ccw.length - 1) % ccw.length];
    const outgoing = normals[index];
    const sumX = incoming.x + outgoing.x;
    const sumZ = incoming.z + outgoing.z;
    const sumLengthSquared = sumX * sumX + sumZ * sumZ;
    // Miter along the angle bisector: scale so both offset edges are met.
    const scale = sumLengthSquared <= 1e-12 ? 0 : 2 * depth / sumLengthSquared;
    if (scale > 0 && Math.hypot(sumX * scale, sumZ * scale) <= depth * 3) {
      result.push({ x: vertex.x + sumX * scale, z: vertex.z + sumZ * scale });
    } else {
      result.push({ x: vertex.x + incoming.x * depth, z: vertex.z + incoming.z * depth });
      result.push({ x: vertex.x + outgoing.x * depth, z: vertex.z + outgoing.z * depth });
    }
  }
  return deduplicateRing(result);
}

/**
 * Uniform-grid spatial index. The optional group keeps unrelated layers (for
 * example separate physical road layers) from ever matching each other.
 */
export class PlanarCellIndex<T> {
  private readonly cells = new Map<string, T[]>();
  private readonly cellSize: number;

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  add(item: T, bounds: PlanarBounds, margin = 0, group = ""): void {
    for (const key of this.keys(bounds, margin, group)) {
      const cell = this.cells.get(key);
      if (cell) cell.push(item);
      else this.cells.set(key, [item]);
    }
  }

  /** Every item whose padded bounds shared at least one cell with the query. */
  query(bounds: PlanarBounds, margin = 0, group = ""): T[] {
    const result = new Set<T>();
    for (const key of this.keys(bounds, margin, group)) {
      for (const item of this.cells.get(key) ?? []) result.add(item);
    }
    return [...result];
  }

  /** Stops at the first match without allocating a deduplicated candidate set. */
  some(bounds: PlanarBounds, predicate: (item: T) => boolean, margin = 0, group = ""): boolean {
    for (const key of this.keys(bounds, margin, group)) {
      if (this.cells.get(key)?.some(predicate)) return true;
    }
    return false;
  }

  queryPoint(point: PlanarPoint, group = ""): readonly T[] {
    const key = `${group}/${Math.floor(point.x / this.cellSize)}/${Math.floor(point.z / this.cellSize)}`;
    return this.cells.get(key) ?? [];
  }

  private *keys(bounds: PlanarBounds, margin: number, group: string): Iterable<string> {
    const minX = Math.floor((bounds.minX - margin) / this.cellSize);
    const maxX = Math.floor((bounds.maxX + margin) / this.cellSize);
    const minZ = Math.floor((bounds.minZ - margin) / this.cellSize);
    const maxZ = Math.floor((bounds.maxZ + margin) / this.cellSize);
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) yield `${group}/${x}/${z}`;
    }
  }
}

export function closestPointOnSegment(point: PlanarPoint, start: PlanarPoint, end: PlanarPoint): PlanarPoint {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared,
  ));
  return { x: start.x + dx * amount, z: start.z + dz * amount };
}
