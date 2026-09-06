/** Thin surface ribbon, clipped to the terrain's actual water intersection. */
export interface ShorelineGeometry {
  positions: number[];
  indices: number[];
  depths: number[];
}

type Point = [number, number, number];
const MIN_HEIGHT_METERS = -1.5;
const MAX_HEIGHT_METERS = 0.4;
/** Eight samples per incoming wavelength, only across the shallow ribbon. */
const HEIGHT_STEP_METERS = 0.08;

/** Clip before uploading: inland and deep-water triangles cost no draw work. */
export async function createShorelineGeometry(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  metersPerUnit: number,
  waterElevation: number,
  yieldControl?: () => Promise<void>,
  includesPoint?: (x: number, z: number) => boolean,
): Promise<ShorelineGeometry> {
  const result: ShorelineGeometry = { positions: [], indices: [], depths: [] };
  const lower = waterElevation + MIN_HEIGHT_METERS / metersPerUnit;
  const upper = waterElevation + MAX_HEIGHT_METERS / metersPerUnit;
  for (let index = 0; index < indices.length; index += 3) {
    if (index % 3072 === 0) await yieldControl?.();
    const a = indices[index] * 3;
    const b = indices[index + 1] * 3;
    const c = indices[index + 2] * 3;
    if (Math.min(positions[a + 1], positions[b + 1], positions[c + 1]) >= upper ||
        Math.max(positions[a + 1], positions[b + 1], positions[c + 1]) <= lower) continue;
    const triangle: Point[] = [a, b, c].map(offset =>
      [positions[offset], positions[offset + 1], positions[offset + 2]]);
    const strip = clip(clip(triangle, lower, true), upper, false);
    if (strip.length < 3) continue;
    if (includesPoint) {
      const x = strip.reduce((sum, point) => sum + point[0], 0) / strip.length;
      const z = strip.reduce((sum, point) => sum + point[2], 0) / strip.length;
      if (!includesPoint(x, z)) continue;
    }
    const minHeight = Math.min(...strip.map(point => (point[1] - waterElevation) * metersPerUnit));
    const maxHeight = Math.max(...strip.map(point => (point[1] - waterElevation) * metersPerUnit));
    const firstBand = Math.floor((minHeight + 1e-7) / HEIGHT_STEP_METERS);
    const lastBand = Math.max(firstBand, Math.ceil((maxHeight - 1e-7) / HEIGHT_STEP_METERS) - 1);
    for (let band = firstBand; band <= lastBand; band++) {
      const polygon = clip(clip(strip,
        waterElevation + band * HEIGHT_STEP_METERS / metersPerUnit, true),
        waterElevation + (band + 1) * HEIGHT_STEP_METERS / metersPerUnit, false);
      if (polygon.length < 3) continue;
      const start = result.depths.length;
      for (const [x, y, z] of polygon) {
        // Terrain depth testing reveals and hides the beach as water moves.
        result.positions.push(x, waterElevation, z);
        result.depths.push((y - waterElevation) * metersPerUnit);
      }
      for (let vertex = 1; vertex < polygon.length - 1; vertex++) {
        result.indices.push(start, start + vertex, start + vertex + 1);
      }
    }
  }
  return result;
}

function clip(polygon: Point[], height: number, above: boolean): Point[] {
  const result: Point[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const insideA = above ? a[1] >= height : a[1] <= height;
    const insideB = above ? b[1] >= height : b[1] <= height;
    if (insideA) result.push(a);
    if (insideA !== insideB) {
      const t = (height - a[1]) / (b[1] - a[1]);
      result.push([a[0] + (b[0] - a[0]) * t, height, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return result;
}
