/**
 * Procedural rock surface textures. Pure arithmetic with no renderer
 * dependency so the encoding can be verified on its own.
 *
 * Rock UVs span the whole stone once and the material repeats them several
 * times, so one repeat covers roughly a decimetre on a typical boulder. The
 * relief layer carries knobs and facets at that scale; the detail layer adds
 * finer grain together with its own micro-relief.
 */

import { encodeNormalMap, shapedField, toByte } from "./TerrainTextureData";

const NOISE_SEED = 0x726f636b;

export const ROCK_TEXTURE_SIZE = 256;

export interface RockTextureData {
  /** Edge length of both textures in texels. */
  size: number;
  /** RGBA tangent-space normal map for the `bumpTexture` slot. */
  normal: Uint8Array;
  /**
   * RGBA detail map in Babylon's channel convention: red modulates albedo around
   * a neutral 0.5, and alpha/green hold the tangent-space normal xy.
   */
  detail: Uint8Array;
}

let cached: RockTextureData | undefined;

/** Returns the shared rock texture data, generating it on first use. */
export function getRockTextureData(): RockTextureData {
  return cached ??= createRockTextureData();
}

export function createRockTextureData(): RockTextureData {
  const size = ROCK_TEXTURE_SIZE;
  // Weathered stone: a few broad knobs, a crinkled skin and pitting on top.
  const knobs = shapedField(size, 3, 4, 0.55, NOISE_SEED ^ 0x2f7b41, 0.7);
  const crinkle = shapedField(size, 13, 4, 0.5, NOISE_SEED ^ 0x8d1a67, 0.85);
  const pits = shapedField(size, 47, 2, 0.5, NOISE_SEED ^ 0xa1c3d9, 0.9);
  const heights = new Float32Array(size * size);
  for (let index = 0; index < heights.length; index++) {
    heights[index] = knobs[index] * 0.5 + crinkle[index] * 0.36 + pits[index] * 0.14;
  }
  // Slopes are texel differences, so the scale is tied to the texture size:
  // at 256px this gives roughly a third of the texels a visible tilt while the
  // steepest still lean less than 60 degrees.
  const normal = encodeNormalMap(heights, size, 7);

  // Grain: mineral speckle over the crinkle band, with its own micro-relief.
  const coarse = shapedField(size, 5, 3, 0.55, NOISE_SEED ^ 0x3b9aca, 0.75);
  const fine = shapedField(size, 29, 3, 0.5, NOISE_SEED ^ 0x6f4a7c, 0.95);
  const specks = shapedField(size, 83, 2, 0.5, NOISE_SEED ^ 0xc2b2ae, 0.95);
  const grains = new Float32Array(size * size);
  const microHeights = new Float32Array(size * size);
  let grainSum = 0;
  for (let index = 0; index < grains.length; index++) {
    grains[index] = (coarse[index] - 0.5) * 0.3 +
      (fine[index] - 0.5) * 0.6 +
      (specks[index] - 0.5) * 0.55;
    grainSum += grains[index];
    microHeights[index] = coarse[index] * 0.24 + fine[index] * 0.44 + specks[index] * 0.32;
  }

  // Re-centre the grain so distant rocks average back to their vertex colour
  // instead of picking up a tint once the texture is too far away to resolve.
  const grainMean = grainSum / grains.length;
  // The speck band changes every few texels, so a gentler scale keeps the
  // micro-relief from folding over to edge-on.
  const microNormals = encodeNormalMap(microHeights, size, 4.5);
  const detail = new Uint8Array(size * size * 4);
  for (let index = 0; index < grains.length; index++) {
    const target = index * 4;
    detail[target] = toByte(128 + (grains[index] - grainMean) * 64);
    detail[target + 1] = microNormals[target + 1];
    detail[target + 2] = 255;
    detail[target + 3] = microNormals[target];
  }

  return { size, normal, detail };
}
