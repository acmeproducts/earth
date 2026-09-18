/** Iterates a closed ring without requiring a repeated closing vertex. */
export function* ringEdges<T>(points: readonly T[]): Iterable<readonly [T, T]> {
  for (let index = 0; index < points.length; index++) {
    yield [points[index], points[(index + 1) % points.length]];
  }
}

export function pointInPolygon<T>(
  x: number,
  y: number,
  polygon: readonly T[],
  getX: (point: T) => number,
  getY: (point: T) => number,
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index], b = polygon[previous];
    const ax = getX(a), ay = getY(a), bx = getX(b), by = getY(b);
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
