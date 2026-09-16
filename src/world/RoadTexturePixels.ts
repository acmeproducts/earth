import { cellRandom } from '../core/Random';
import { tiledValueNoise } from '../core/ValueNoise';
import type { RoadVisualStyle } from '../roads/RoadPlanner';

export const ROAD_TEXTURE_SIZE = 128;
/** Non-repeating per-pixel grain, distinct from the seamless octaves. */
const ROAD_GRAIN_SEED = 0x726f6164;
export type RoadMaterialStyle = RoadVisualStyle | "pavedShoulder" | "unpavedShoulder" | "bridgeDeck";
const pixelsByStyle = new Map<RoadMaterialStyle, Uint8Array>();

/** Deterministic CPU pixels shared across tiles and diffuse/relief uploads.
 * Treat the returned bytes as immutable. Each caller still owns its GPU texture.
 */
export function roadTexturePixels(visualStyle: RoadMaterialStyle): Uint8Array {
  const cached = pixelsByStyle.get(visualStyle);
  if (cached) return cached;
  const coarseGravel = visualStyle === 'unpaved' || visualStyle === 'unpavedShoulder';
  const gravel = coarseGravel || visualStyle === 'dirt';
  const pixels = new Uint8Array(ROAD_TEXTURE_SIZE * ROAD_TEXTURE_SIZE * 4);
  for (let y = 0; y < ROAD_TEXTURE_SIZE; y++) {
    for (let x = 0; x < ROAD_TEXTURE_SIZE; x++) {
      const offset = (y * ROAD_TEXTURE_SIZE + x) * 4;
      const fine = cellRandom(ROAD_GRAIN_SEED, x, y);
      const coarse = cellRandom(ROAD_GRAIN_SEED, Math.floor(x / 4), Math.floor(y / 4));
      // Periodic value noise crosses the wrapped edges smoothly. Several
      // incommensurate scales read as varied aggregate without the old square
      // four-pixel clumps advertising each texture tile.
      const gravelBroad = gravel ? tiledValueNoise(x, y, ROAD_TEXTURE_SIZE, 7, 0x45d9f3b) : 0;
      const gravelCluster = gravel ? tiledValueNoise(x, y, ROAD_TEXTURE_SIZE, 23, 0x119de1f3) : 0;
      const gravelGrain = coarseGravel ? tiledValueNoise(x, y, ROAD_TEXTURE_SIZE, 53, 0x3449f5) : 0;
      const centerMark = visualStyle === "marked" &&
        Math.abs(y - (ROAD_TEXTURE_SIZE - 1) / 2) <= 1.25 &&
        x < ROAD_TEXTURE_SIZE * 0.58;
      const value = centerMark
        ? 235
        : visualStyle === "marked"
          ? 55 + Math.round((fine - 0.5) * 10)
          : visualStyle === "dirt"
            ? 174 + Math.round(
              (gravelBroad - 0.5) * 22 +
              (gravelCluster - 0.5) * 10 +
              (fine - 0.5) * 6
            )
          : visualStyle === "unpaved" || visualStyle === "unpavedShoulder"
            ? 164 + Math.round(
              (gravelBroad - 0.5) * 14 +
              (gravelCluster - 0.5) * 24 +
              (gravelGrain - 0.5) * 12
            )
            : visualStyle === "pedestrian"
              ? 185 + Math.round((fine - 0.5) * 18 + (coarse - 0.5) * 8)
              : visualStyle === "ford"
                ? 132 + Math.round((fine - 0.5) * 28 + (coarse - 0.5) * 12)
                : visualStyle === "pavedShoulder"
                  ? 148 + Math.round((fine - 0.5) * 28 + (coarse - 0.5) * 10)
                  : visualStyle === "bridgeDeck"
                    ? 118 + Math.round((fine - 0.5) * 16)
                    : 175 + Math.round((fine - 0.5) * 24);
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      // Opaque coverage avoids faded rims on joins and small circular pieces.
      pixels[offset + 3] = 255;
    }
  }
  pixelsByStyle.set(visualStyle, pixels);
  return pixels;
}
