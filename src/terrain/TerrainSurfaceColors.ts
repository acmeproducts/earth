import { sceneToLonLat } from "../world/Geo";
import { landCoverSurfaceColor } from "../world/WorldCover";
import type { LandCoverSampler } from "../world/WorldCover";
import type { TerrainData } from "./TerrainData";

const COLOR_SPACING_METERS = 6;
const BLEND_RADIUS_METERS = 12;

async function filterColorAxis(
  source: Float32Array, width: number, height: number, insetX: number, insetY: number,
  radius: number, stride: number, yieldControl?: () => Promise<void>,
): Promise<Float32Array> {
  const filtered = new Float32Array(source.length);
  for (let y = insetY; y < height - insetY; y++) {
    for (let x = insetX; x < width - insetX; x++) {
      for (let channel = 0; channel < 3; channel++) {
        const index = (y * width + x) * 3 + channel;
        let sum = 0;
        for (let offset = -radius; offset <= radius; offset++) {
          sum += source[index + offset * stride];
        }
        filtered[index] = sum / (radius * 2 + 1);
      }
    }
    await yieldControl?.();
  }
  return filtered;
}

/** A padded color field independent of the render mesh's level of detail. */
export async function createTerrainSurfaceColors(
  terrain: TerrainData,
  cover: LandCoverSampler,
  yieldControl?: () => Promise<void>,
): Promise<(u: number, v: number) => [number, number, number]> {
  const columns = Math.max(1, Math.ceil(terrain.groundWidthMeters / COLOR_SPACING_METERS));
  const rows = Math.max(1, Math.ceil(terrain.groundHeightMeters / COLOR_SPACING_METERS));
  const radiusX = Math.ceil(BLEND_RADIUS_METERS * columns / terrain.groundWidthMeters);
  const radiusY = Math.ceil(BLEND_RADIUS_METERS * rows / terrain.groundHeightMeters);
  const width = columns + 1 + radiusX * 2;
  const height = rows + 1 + radiusY * 2;
  const source = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { lon, lat } = sceneToLonLat(
        (x - radiusX) / columns - 0.5, 0.5 - (y - radiusY) / rows,
        terrain.bounds, 1, 1,
      );
      source.set(cover.sampleSurfaceColor?.(lon, lat) ??
        landCoverSurfaceColor(cover.sample(lon, lat)), (y * width + x) * 3);
    }
    await yieldControl?.();
  }
  const horizontal = await filterColorAxis(source, width, height, radiusX, 0, radiusX, 3, yieldControl);
  const filtered = await filterColorAxis(horizontal, width, height, radiusX, radiusY, radiusY, width * 3, yieldControl);
  return (u, v) => {
    const x = Math.max(0, Math.min(1, u)) * columns;
    const y = Math.max(0, Math.min(1, v)) * rows;
    const x0 = Math.min(columns - 1, Math.floor(x));
    const y0 = Math.min(rows - 1, Math.floor(y));
    const fx = x - x0, fy = y - y0;
    const index = ((y0 + radiusY) * width + x0 + radiusX) * 3;
    const result: [number, number, number] = [0, 0, 0];
    for (let channel = 0; channel < 3; channel++) {
      const top = filtered[index + channel] * (1 - fx) + filtered[index + 3 + channel] * fx;
      const bottom = filtered[index + width * 3 + channel] * (1 - fx) +
        filtered[index + width * 3 + 3 + channel] * fx;
      result[channel] = top * (1 - fy) + bottom * fy;
    }
    return result;
  };
}
