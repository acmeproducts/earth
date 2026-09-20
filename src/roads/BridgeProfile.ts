import type { PlanarPoint } from '../core/PlanarGeometry';

/** The lowest concave span above the constraints: bridges cross valleys instead of following them. */
export function bridgeProfile(points: readonly PlanarPoint[], minimumElevations: readonly number[]): number[] {
  if (points.length < 2) return [...minimumElevations];
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  const anchors: number[] = [];
  for (let i = 0; i < points.length; i++) {
    while (anchors.length >= 2) {
      const a = anchors[anchors.length - 2], b = anchors[anchors.length - 1];
      if ((minimumElevations[b] - minimumElevations[a]) * (distances[i] - distances[b]) >
          (minimumElevations[i] - minimumElevations[b]) * (distances[b] - distances[a])) break;
      anchors.pop();
    }
    anchors.push(i);
  }
  const result = [...minimumElevations];
  for (let segment = 1; segment < anchors.length; segment++) {
    const a = anchors[segment - 1], b = anchors[segment];
    const length = distances[b] - distances[a];
    for (let i = a; i <= b; i++) {
      const t = length > 0 ? (distances[i] - distances[a]) / length : 0;
      result[i] = Math.max(minimumElevations[i], minimumElevations[a] * (1 - t) + minimumElevations[b] * t);
    }
  }
  return result;
}
