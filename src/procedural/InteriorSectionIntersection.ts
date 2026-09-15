import polygonClipping from "polygon-clipping";

/** Retry sweep-line precision failures on a local, physical-unit integer grid. */
export function intersectInteriorSections(
  first: polygonClipping.Polygon,
  second: polygonClipping.Polygon,
  metersPerUnit: number,
): polygonClipping.MultiPolygon {
  try {
    return polygonClipping.intersection(first, second);
  } catch (error) {
    if (!isPrecisionFailure(error)) throw error;
    if (!Number.isFinite(metersPerUnit) || metersPerUnit <= 0) throw error;
    const origin = first[0]?.[0];
    if (!origin) throw error;
    // Normal geometry is untouched. Recovery moves vertices by at most half a
    // grid cell per axis, first 0.1 mm, then 1 mm if the finer grid still fails.
    for (const gridMeters of [0.0001, 0.001]) {
      const scale = metersPerUnit / gridMeters;
      const left = snapPolygon(first, origin, scale);
      const right = snapPolygon(second, origin, scale);
      if (!left.length || !right.length) return [];
      try {
        return polygonClipping.intersection(left, right).map((polygon) => polygon.map((ring) =>
          ring.map(([x, z]): [number, number] => [origin[0] + x / scale, origin[1] + z / scale])));
      } catch (retryError) {
        if (!isPrecisionFailure(retryError)) throw retryError;
      }
    }
    throw error;
  }
}

function isPrecisionFailure(error: unknown): boolean {
  return error instanceof Error && /Unable to find segment|Unable to complete output ring|Tried to create degenerate segment/.test(error.message);
}

function snapPolygon(
  polygon: polygonClipping.Polygon,
  origin: [number, number],
  scale: number,
): polygonClipping.Polygon {
  const rings: polygonClipping.Polygon = [];
  for (const [index, ring] of polygon.entries()) {
    const points: [number, number][] = [];
    for (const [x, z] of ring) {
      const point: [number, number] = [Math.round((x - origin[0]) * scale), Math.round((z - origin[1]) * scale)];
      const previous = points[points.length - 1];
      if (!previous || point[0] !== previous[0] || point[1] !== previous[1]) points.push(point);
    }
    if (points.length > 1 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]) points.pop();
    const area = points.reduce((sum, point, i) => {
      const next = points[(i + 1) % points.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0);
    if (points.length < 3 || area === 0) {
      if (index === 0) return [];
      continue;
    }
    rings.push(points);
  }
  return rings;
}
