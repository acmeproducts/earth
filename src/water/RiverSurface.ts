import type { PlanarPoint } from '../core/PlanarGeometry';

export function riverChannelDepth(halfWidthMeters: number): number {
  return Math.min(1.8, Math.max(0.25, halfWidthMeters * 0.25));
}

/** Smooth the centreline grade independently of bank slopes and bed triangles. */
export function riverSurfaceLevels(
  points: readonly PlanarPoint[],
  heightAt: (point: PlanarPoint) => number,
  smoothingDistance: number,
): number[] {
  const heights = points.map(heightAt);
  const distances = points.map(() => 0);
  for (let i = 1; i < points.length; i++) distances[i] = distances[i - 1] +
    Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return heights.map((height, index) => {
    // Symmetric windows preserve a steady river grade, including at tile edges.
    const radius = Math.min(smoothingDistance, distances[index], distances[distances.length - 1] - distances[index]);
    if (radius <= 0) return height;
    let sum = height;
    let weight = 1;
    for (const direction of [-1, 1]) {
      for (let i = index + direction; i >= 0 && i < heights.length; i += direction) {
        const distance = Math.abs(distances[i] - distances[index]);
        if (distance >= radius) break;
        const influence = 1 - distance / radius;
        sum += heights[i] * influence;
        weight += influence;
      }
    }
    return sum / weight;
  });
}

/** Fit the overall grade so small DEM bumps cannot reverse individual reaches. */
export function riverFlowSign(points: readonly PlanarPoint[], heightAt: (point: PlanarPoint) => number): number {
  let distance = 0;
  let sumDistance = 0;
  let sumHeight = 0;
  let sumProduct = 0;
  for (let index = 0; index < points.length; index++) {
    if (index) distance += Math.hypot(points[index].x - points[index - 1].x,
      points[index].z - points[index - 1].z);
    const height = heightAt(points[index]);
    sumDistance += distance;
    sumHeight += height;
    sumProduct += distance * height;
  }
  // Flat canals keep the mapped direction.
  return points.length * sumProduct - sumDistance * sumHeight > 1e-6 ? -1 : 1;
}

/** Continuous coordinates at mitered joins, including terrain-clipped vertices. */
export function riverSurfaceFrame(
  point: PlanarPoint,
  leftStart: PlanarPoint, rightStart: PlanarPoint,
  leftEnd: PlanarPoint, rightEnd: PlanarPoint,
  startDistance: number, length: number, width: number,
  normal: { x: number; y: number; z: number },
  flowSign: number,
) {
  const side = (left: PlanarPoint, right: PlanarPoint) =>
    (right.x - left.x) * (point.z - left.z) - (right.z - left.z) * (point.x - left.x);
  const first = side(leftStart, rightStart);
  const last = side(leftEnd, rightEnd);
  const along = Math.abs(first - last) < 1e-12 ? 0 : Math.max(0, Math.min(1, first / (first - last)));
  const lx = leftStart.x + (leftEnd.x - leftStart.x) * along;
  const lz = leftStart.z + (leftEnd.z - leftStart.z) * along;
  const acrossX = rightStart.x + (rightEnd.x - rightStart.x) * along - lx;
  const acrossZ = rightStart.z + (rightEnd.z - rightStart.z) * along - lz;
  const acrossLength = acrossX * acrossX + acrossZ * acrossZ;
  const across = acrossLength < 1e-12 ? 0.5 :
    ((point.x - lx) * acrossX + (point.z - lz) * acrossZ) / acrossLength;
  const dot = acrossX * normal.x + acrossZ * normal.z;
  const tx = acrossX - dot * normal.x;
  const ty = -dot * normal.y;
  const tz = acrossZ - dot * normal.z;
  const magnitude = Math.hypot(tx, ty, tz) || 1;
  const forwardX = leftEnd.x + rightEnd.x - leftStart.x - rightStart.x;
  const forwardZ = leftEnd.z + rightEnd.z - leftStart.z - rightStart.z;
  const handedness = Math.sign(((normal.y * tz - normal.z * ty) * forwardX +
    (normal.x * ty - normal.y * tx) * forwardZ) * flowSign) || 1;
  return {
    u: (across - 0.5) * width,
    v: (startDistance + along * length) * flowSign,
    tangent: [tx / magnitude, ty / magnitude, tz / magnitude, handedness],
  };
}
