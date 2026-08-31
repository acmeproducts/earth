import earcut from "earcut";

export function isConvexPolygon(points) {
  let direction = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const c = points[(index + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-8) continue;
    const nextDirection = Math.sign(cross);
    if (direction !== 0 && direction !== nextDirection) return false;
    direction = nextDirection;
  }
  return true;
}

/** Decomposes a concave simple polygon into exact, convex triangles. */
export function decomposeToConvexPolygons(points) {
  if (isConvexPolygon(points)) return [[...points]];
  const partitioned = splitAtReflexCorners(counterClockwise([...points]));
  if (partitioned) return partitioned;
  // A malformed ring can defeat the geometric cuts below. Ear clipping still
  // gives a footprint-faithful last resort rather than dropping the building.
  return earcutDecomposition(points);
}

function earcutDecomposition(points) {
  const indices = earcut(points.flatMap((point) => [point.x, point.y]));
  const pieces = [];
  for (let index = 0; index < indices.length; index += 3) {
    const triangle = [points[indices[index]], points[indices[index + 1]], points[indices[index + 2]]]
      .map((point) => ({ ...point }));
    if (Math.abs(signedArea(triangle)) > 1e-7) pieces.push(signedArea(triangle) < 0 ? triangle.reverse() : triangle);
  }
  let merged = true;
  while (merged) {
    merged = false;
    let best;
    for (let first = 0; first < pieces.length; first++) {
      for (let second = first + 1; second < pieces.length; second++) {
        const candidate = mergeConvexNeighbours(pieces[first], pieces[second]);
        if (candidate) {
          const aspect = aspectRatio(candidate.polygon);
          if (!best || aspect < best.aspect - 1e-7 ||
              (Math.abs(aspect - best.aspect) < 1e-7 && candidate.sharedLength > best.sharedLength)) {
            best = { first, second, aspect, ...candidate };
          }
        }
      }
    }
    if (best) {
      pieces.splice(best.second, 1);
      pieces[best.first] = best.polygon;
      merged = true;
    }
  }
  return pieces;
}

function splitAtReflexCorners(points, remainingCuts = 64) {
  if (isConvexPolygon(points)) return [points];
  if (remainingCuts <= 0) return undefined;
  const split = bestReflexSplit(points);
  if (!split) return undefined;
  const first = splitAtReflexCorners(split.first, remainingCuts - 1);
  const second = splitAtReflexCorners(split.second, remainingCuts - 1);
  return first && second ? [...first, ...second] : undefined;
}

function bestReflexSplit(points) {
  const axis = dominantAxis(points);
  const directions = [axis, { x: -axis.x, y: -axis.y }, { x: -axis.y, y: axis.x }, { x: axis.y, y: -axis.x }];
  let best;
  for (let vertex = 0; vertex < points.length; vertex++) {
    const previous = points[(vertex + points.length - 1) % points.length];
    const current = points[vertex];
    const next = points[(vertex + 1) % points.length];
    if (cross(previous, current, next) >= -1e-7) continue;
    for (const direction of directions) {
      const hit = nearestRayHit(points, vertex, direction);
      if (!hit || !pointInside({ x: current.x + direction.x * Math.min(0.03, hit.distance / 2), y: current.y + direction.y * Math.min(0.03, hit.distance / 2) }, points)) continue;
      const candidate = splitPolygonAtCut(points, vertex, hit.edge, hit.point);
      if (!candidate) continue;
      const firstArea = Math.abs(signedArea(candidate.first));
      const secondArea = Math.abs(signedArea(candidate.second));
      if (firstArea < 0.05 || secondArea < 0.05) continue;
      const score = Math.max(aspectRatio(candidate.first), aspectRatio(candidate.second)) +
        Math.abs(firstArea - secondArea) / (firstArea + secondArea) * 0.25;
      if (!best || score < best.score) best = { ...candidate, score };
    }
  }
  return best;
}

function nearestRayHit(points, vertex, direction) {
  const origin = points[vertex];
  let nearest;
  for (let edge = 0; edge < points.length; edge++) {
    if (edge === vertex || (edge + 1) % points.length === vertex) continue;
    const hit = raySegmentIntersection(origin, direction, points[edge], points[(edge + 1) % points.length]);
    if (!hit || hit.distance < 1e-6 || hit.fraction < 1e-6 || hit.fraction > 1 - 1e-6) continue;
    if (!nearest || hit.distance < nearest.distance) nearest = { edge, ...hit };
  }
  return nearest;
}

function raySegmentIntersection(origin, direction, start, end) {
  const edge = { x: end.x - start.x, y: end.y - start.y };
  const denominator = direction.x * edge.y - direction.y * edge.x;
  if (Math.abs(denominator) < 1e-9) return undefined;
  const delta = { x: start.x - origin.x, y: start.y - origin.y };
  const distance = (delta.x * edge.y - delta.y * edge.x) / denominator;
  const fraction = (delta.x * direction.y - delta.y * direction.x) / denominator;
  return distance > 0 && fraction >= 0 && fraction <= 1
    ? { distance, fraction, point: { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance } }
    : undefined;
}

function splitPolygonAtCut(points, vertex, edge, point) {
  const first = [points[vertex]];
  for (let index = (vertex + 1) % points.length; index !== (edge + 1) % points.length; index = (index + 1) % points.length) first.push(points[index]);
  first.push(point);
  const second = [point];
  for (let index = (edge + 1) % points.length; index !== vertex; index = (index + 1) % points.length) second.push(points[index]);
  second.push(points[vertex]);
  return first.length >= 3 && second.length >= 3
    ? { first: counterClockwise(first), second: counterClockwise(second) }
    : undefined;
}

function dominantAxis(points) {
  let best = { x: 1, y: 0, length: 0 };
  for (let index = 0; index < points.length; index++) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const x = end.x - start.x;
    const y = end.y - start.y;
    const length = Math.hypot(x, y);
    if (length > best.length) best = { x: x / length, y: y / length, length };
  }
  return best;
}

function pointInside(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

export function mergeConvexNeighbours(first, second) {
  const edges = new Map();
  let sharedLength = 0;
  for (const polygon of [first, second]) {
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const reverse = edgeKey(end, start);
      if (edges.has(reverse)) {
        edges.delete(reverse);
        sharedLength += Math.hypot(end.x - start.x, end.y - start.y);
      } else edges.set(edgeKey(start, end), { start, end });
    }
  }
  if (sharedLength < 1e-7) return undefined;
  const remaining = [...edges.values()];
  const polygon = [remaining[0].start];
  let end = remaining[0].end;
  remaining.splice(0, 1);
  while (remaining.length > 0) {
    polygon.push(end);
    const nextIndex = remaining.findIndex((edge) => samePoint(edge.start, end));
    if (nextIndex < 0) return undefined;
    end = remaining[nextIndex].end;
    remaining.splice(nextIndex, 1);
  }
  if (!samePoint(end, polygon[0]) || polygon.length < 3) return undefined;
  const normalized = removeCollinear(counterClockwise(polygon));
  return isConvexPolygon(normalized) ? { polygon: normalized, sharedLength } : undefined;
}

function removeCollinear(points) {
  return points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    return Math.abs((point.x - previous.x) * (next.y - point.y) -
      (point.y - previous.y) * (next.x - point.x)) > 1e-8;
  });
}

function counterClockwise(points) {
  return signedArea(points) < 0 ? [...points].reverse() : points;
}

function edgeKey(start, end) {
  return `${start.x.toFixed(8)},${start.y.toFixed(8)}>${end.x.toFixed(8)},${end.y.toFixed(8)}`;
}

function samePoint(first, second) {
  return Math.abs(first.x - second.x) < 1e-7 && Math.abs(first.y - second.y) < 1e-7;
}

function aspectRatio(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return Math.max(width / Math.max(height, 1e-7), height / Math.max(width, 1e-7));
}

function signedArea(points) {
  return points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}
