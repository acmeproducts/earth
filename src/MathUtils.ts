/** Clamps a number to an inclusive range. */
export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Clamps a number to the normalized zero-to-one range. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Hermite interpolation between two edges, matching GLSL smoothstep. */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = clamp01((value - edge0) / (edge1 - edge0));
  return amount * amount * (3 - 2 * amount);
}
