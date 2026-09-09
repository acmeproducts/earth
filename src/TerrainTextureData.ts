/**
 * Procedural ground texture data. Pure arithmetic with no renderer dependency so
 * the detail cascade can be reasoned about and tested on its own.
 *
 * The layers exist because a single tiling texture cannot serve a camera that
 * both stands on the ground and looks at the horizon. Stretching one 512px
 * texture over tens of metres leaves roughly 10cm texels, which a walking camera
 * magnifies about fortyfold: whatever the texture contains ends up reading as
 * blotches. Splitting the work across repeats an order of magnitude apart keeps
 * every viewing distance supplied with real detail.
 */

import { lerp, wrap } from "./MathUtils";
import { fractalValueNoise } from "./ValueNoise";

import { clamp01, smoothstep } from "./MathUtils";

/**
 * Chosen, not arbitrary. The coarsest patch octave spans only a 3x3 lattice
 * across the texture, so whether its low-frequency content reads as tiling is
 * decided by a handful of lattice values: measured over arbitrary seeds the
 * 4x4 block brightness spread ranges from 5.9/255 to 10.8/255. This one sits
 * near the bottom of that range, and `terrain-texture-detail` pins it there.
 */
const NOISE_SEED = 0x2b7e1516;

export interface TerrainTextureLayer {
  /** Edge length of the generated texture in texels. */
  size: number;
  /** Ground distance covered by one repeat of this layer, in meters. */
  metersPerRepeat: number;
}

/**
 * Metre-to-centimetre surface colour. Its repeat is only a few metres across, so
 * the noise deliberately starts above the lowest frequencies: strong macro
 * content here would read as a tiling grid. Land-cover vertex colours own that
 * band instead.
 */
export const TERRAIN_ALBEDO_LAYER: TerrainTextureLayer = {
  size: 512,
  metersPerRepeat: 9.5,
};

/** Relief for the same band, tiled tighter so the two never repeat in step. */
export const TERRAIN_NORMAL_LAYER: TerrainTextureLayer = {
  size: 512,
  metersPerRepeat: 5.3,
};

/**
 * The closest layer, carrying both grain and micro-relief. Its repeat is just
 * over a metre, which puts a texel near two millimetres of ground — the scale a
 * camera standing on the terrain actually resolves.
 */
export const TERRAIN_DETAIL_LAYER: TerrainTextureLayer = {
  size: 512,
  metersPerRepeat: 1.15,
};

export interface TerrainTextureData {
  /** RGBA surface colour. */
  albedo: Uint8Array;
  /** RGBA tangent-space normal map. */
  normal: Uint8Array;
  /**
   * RGBA detail map in Babylon's channel convention: red modulates albedo around
   * a neutral 0.5, and alpha/green hold the tangent-space normal xy.
   */
  detail: Uint8Array;
}

/** Ground distance covered by one texel of a layer, in meters. */
export function metersPerTexel(layer: TerrainTextureLayer): number {
  return layer.metersPerRepeat / layer.size;
}

export function createTerrainTextureData(): TerrainTextureData {
  const { albedo, normal } = createBaseTextureData(TERRAIN_ALBEDO_LAYER.size);
  return { albedo, normal, detail: createDetailTextureData(TERRAIN_DETAIL_LAYER.size) };
}

function createBaseTextureData(
  size: number,
): { albedo: Uint8Array; normal: Uint8Array } {
  const albedo = new Uint8Array(size * size * 4);

  // At a 9.5m repeat these bands cover roughly 3m patches, 45cm grain and 13cm
  // flecks. Each is contrast-shaped rather than used raw: a fractal sum clusters
  // tightly around its own mean, so mixing colors across [0, 1] with it would
  // only ever reach a sliver of the palette and leave a near-flat grey.
  const patch = shapedField(size, 3, 5, 0.55, NOISE_SEED, 0.62);
  const grain = shapedField(size, 21, 4, 0.5, NOISE_SEED ^ 0x51f15e, 0.95);
  const flecks = shapedField(size, 72, 2, 0.5, NOISE_SEED ^ 0x9e3779b9, 0.85);

  for (let index = 0; index < patch.length; index++) {
    const moss = clamp01(0.5 + (patch[index] - 0.5) * 0.9 + (grain[index] - 0.5) * 0.3);
    const dry = smoothstep(0.55, 0.9, patch[index] + (grain[index] - 0.5) * 0.3);
    const stone = smoothstep(0.6, 0.92, flecks[index] + (grain[index] - 0.5) * 0.2);

    // Damp soil through to lichen-green, then the drier and stonier variants.
    // The palette stays light overall because land-cover vertex colors supply
    // the actual hue and these values only modulate it.
    let red = lerp(206, 172, moss);
    let green = lerp(197, 187, moss);
    let blue = lerp(173, 153, moss);
    red = lerp(red, 232, dry * 0.55);
    green = lerp(green, 218, dry * 0.55);
    blue = lerp(blue, 176, dry * 0.55);
    red = lerp(red, 207, stone * 0.5);
    green = lerp(green, 207, stone * 0.5);
    blue = lerp(blue, 203, stone * 0.5);

    const shade = (grain[index] - 0.5) * 30 + (flecks[index] - 0.5) * 22;
    const target = index * 4;
    albedo[target] = toByte(red + shade);
    albedo[target + 1] = toByte(green + shade * 0.86);
    albedo[target + 2] = toByte(blue + shade * 0.62);
    albedo[target + 3] = 255;
  }

  // The normal layer tiles tighter than the albedo, so it carries its own
  // relief rather than a height field derived from the colors above.
  const bumps = shapedField(size, 5, 5, 0.55, NOISE_SEED ^ 0x2f7b41, 0.7);
  const crinkle = shapedField(size, 37, 4, 0.5, NOISE_SEED ^ 0x8d1a67, 0.85);
  const micro = shapedField(size, 112, 2, 0.5, NOISE_SEED ^ 0xa1c3d9, 0.85);
  const heights = new Float32Array(size * size);
  for (let index = 0; index < heights.length; index++) {
    heights[index] = bumps[index] * 0.4 + crinkle[index] * 0.42 + micro[index] * 0.18;
  }

  return { albedo, normal: encodeNormalMap(heights, size, 2.6) };
}

function createDetailTextureData(size: number): Uint8Array {
  const detail = new Uint8Array(size * size * 4);

  // At a 1.15m repeat these bands cover roughly 16cm clusters, 2cm granules and
  // 6mm specks.
  const coarse = shapedField(size, 7, 4, 0.55, NOISE_SEED ^ 0x3b9aca, 0.75);
  const fine = shapedField(size, 53, 3, 0.5, NOISE_SEED ^ 0x6f4a7c, 0.95);
  const specks = shapedField(size, 96, 2, 0.5, NOISE_SEED ^ 0xc2b2ae, 0.95);

  const grains = new Float32Array(size * size);
  const heights = new Float32Array(size * size);
  let grainSum = 0;
  for (let index = 0; index < grains.length; index++) {
    grains[index] = (coarse[index] - 0.5) * 0.34 +
      (fine[index] - 0.5) * 0.72 +
      (specks[index] - 0.5) * 0.5;
    grainSum += grains[index];
    heights[index] = coarse[index] * 0.26 + fine[index] * 0.46 + specks[index] * 0.28;
  }

  // Re-centre the grain so the coarsest mip level averages back to an exactly
  // neutral 0.5. Without this the layer would tint the whole terrain once it is
  // too far away to resolve, instead of quietly fading out.
  const grainMean = grainSum / grains.length;
  const normals = encodeNormalMap(heights, size, 3.4);
  for (let index = 0; index < grains.length; index++) {
    const target = index * 4;
    detail[target] = toByte(128 + (grains[index] - grainMean) * 58);
    detail[target + 1] = normals[target + 1];
    detail[target + 2] = 255;
    detail[target + 3] = normals[target];
  }
  return detail;
}

/**
 * Builds a tiling noise field remapped to an explicit contrast.
 *
 * The raw fractal is standardised and then pushed through a tanh curve, which
 * spreads it across [0, 1] while staying smooth: hard clamping would instead
 * flatten the extremes into plateaus that read as blotches. Higher gain means
 * more contrast.
 */
export function shapedField(
  size: number,
  startFrequency: number,
  octaves: number,
  persistence: number,
  seed: number,
  gain: number,
): Float32Array {
  const field = new Float32Array(size * size);
  let sum = 0;
  let sumOfSquares = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = fractalValueNoise(x, y, size, startFrequency, octaves, persistence, seed);
      field[y * size + x] = value;
      sum += value;
      sumOfSquares += value * value;
    }
  }

  const mean = sum / field.length;
  const deviation = Math.sqrt(Math.max(1e-12, sumOfSquares / field.length - mean * mean));
  for (let index = 0; index < field.length; index++) {
    field[index] = 0.5 + 0.5 * Math.tanh(((field[index] - mean) / deviation) * gain);
  }
  return field;
}

/**
 * Encodes a tiling height field as an RGBA tangent-space normal map.
 *
 * This is the only way a procedural texture may reach a `bumpTexture` slot:
 * Babylon decodes whatever it is given as `rgb * 2 - 1`, so a grayscale field
 * fed in directly yields normals that lean diagonally and flip into the surface
 * wherever the texel is darker than mid-grey.
 */
export function encodeNormalMap(
  heights: Float32Array,
  size: number,
  slopeScale: number,
): Uint8Array {
  const normal = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const left = heights[y * size + wrap(x - 1, size)];
      const right = heights[y * size + wrap(x + 1, size)];
      const up = heights[wrap(y - 1, size) * size + x];
      const down = heights[wrap(y + 1, size) * size + x];
      const nx = (left - right) * slopeScale;
      const ny = (up - down) * slopeScale;
      const inverseLength = 1 / Math.hypot(nx, ny, 1);
      const index = (y * size + x) * 4;
      normal[index] = toByte((nx * inverseLength * 0.5 + 0.5) * 255);
      normal[index + 1] = toByte((ny * inverseLength * 0.5 + 0.5) * 255);
      normal[index + 2] = toByte(inverseLength * 255);
      normal[index + 3] = 255;
    }
  }
  return normal;
}

export function toByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
