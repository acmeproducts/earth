/** Clamps a number to an inclusive range. */
export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Clamps a number to the normalized zero-to-one range. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Hermite interpolation between two edges, matching GLSL smoothstep. GLSL
 * leaves a collapsed range undefined; here it degenerates to a hard step,
 * which is the limit of the ramp and keeps callers from producing NaN.
 */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  const amount = clamp01((value - edge0) / (edge1 - edge0));
  return amount * amount * (3 - 2 * amount);
}

/** Linear interpolation between two values. */
export function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/** Wraps a value into [0, modulus), for negative values too. */
export function wrap(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
