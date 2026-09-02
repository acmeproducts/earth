import { lerp, smoothstep, wrap } from "./MathUtils";
import { cellRandom } from "./Random";

/**
 * Seamless value noise for generated textures.
 *
 * A texture that repeats has to have noise that repeats with it, or the seam
 * lands on a visible discontinuity every tile. Taking the lattice modulo the
 * octave frequency instead of leaving it unbounded is what makes the field
 * close on itself: the cell east of the last column is the first column.
 *
 * `SimplexNoise2D` is the right tool for world-anchored fields, which are
 * sampled once per placement and never need to wrap. This is the right tool
 * for the inside of a tiling texture, which is sampled once per pixel and
 * always does.
 */

/** One octave of periodic value noise, in [0, 1), repeating every `size`. */
export function tiledValueNoise(
  x: number,
  y: number,
  size: number,
  frequency: number,
  seed: number,
): number {
  const sampleX = (x / size) * frequency;
  const sampleY = (y / size) * frequency;
  const cellX = Math.floor(sampleX);
  const cellY = Math.floor(sampleY);
  const blendX = smoothstep(0, 1, sampleX - cellX);
  const blendY = smoothstep(0, 1, sampleY - cellY);
  const corner = (offsetX: number, offsetY: number): number => cellRandom(
    seed,
    wrap(cellX + offsetX, frequency),
    wrap(cellY + offsetY, frequency),
  );
  return lerp(
    lerp(corner(0, 0), corner(1, 0), blendX),
    lerp(corner(0, 1), corner(1, 1), blendX),
    blendY,
  );
}

/**
 * Octaves of `tiledValueNoise` summed at halving amplitude, normalized back to
 * [0, 1). Each octave doubles the frequency, so the whole stack stays periodic.
 */
export function fractalValueNoise(
  x: number,
  y: number,
  size: number,
  startFrequency: number,
  octaves: number,
  persistence: number,
  seed: number,
): number {
  let value = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = startFrequency;
  for (let octave = 0; octave < octaves; octave++) {
    value += tiledValueNoise(x, y, size, frequency, seed + octave * 1013) * amplitude;
    total += amplitude;
    amplitude *= persistence;
    frequency *= 2;
  }
  return value / total;
}
