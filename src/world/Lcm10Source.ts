import { ResourceCache } from "../core/ResourceCache";
import { mapGridRange } from "../core/GridSampling";
import type { TileBounds } from "./WorldGrid";

export interface LandCoverRaster {
  width: number;
  pixels: readonly ArrayLike<number>[];
  mask?: ArrayLike<number> | null;
}

export const LCM10_RESOLUTION = 1 / 12_000;
// 240 divides the source's 36,000-pixel tiles, so requests never cross an item boundary.
export const LCM10_TILE_SIZE = 240;
const SERVICE = "https://titiler.terrascope.be/collections/lcfm-lcm-10/items";
const cache = new ResourceCache<LandCoverRaster | undefined>(16 * 1024 * 1024,
  (tile) => tile ? tile.width * tile.width * 2 : 0);
const availability = new ResourceCache<boolean>(512, () => 1, 512);

// LCM-10 codes differ from ESA WorldCover after cropland. Zero marks missing data.
const LAND_COVER_CLASSES: Readonly<Record<number, number>> = {
  10: 10, 20: 20, 30: 30, 40: 40, 50: 90, 60: 95,
  70: 100, 80: 60, 90: 50, 100: 80, 110: 70,
};

export function lcm10ClassToLandCover(value: number): number {
  return LAND_COVER_CLASSES[value] ?? 0;
}

export function lcm10TileRequest(row: number, column: number): string {
  const west = -180 + column * LCM10_TILE_SIZE / 12_000;
  const north = 84 - row * LCM10_TILE_SIZE / 12_000;
  const east = west + LCM10_TILE_SIZE / 12_000;
  const south = north - LCM10_TILE_SIZE / 12_000;
  const itemLat = Math.floor(((north + south) / 2) / 3) * 3;
  const itemLon = Math.floor(((west + east) / 2) / 3) * 3;
  const lat = `${itemLat < 0 ? "S" : "N"}${Math.abs(itemLat).toString().padStart(2, "0")}`;
  const lon = `${itemLon < 0 ? "W" : "E"}${Math.abs(itemLon).toString().padStart(3, "0")}`;
  const bbox = [west, south, east, north].map(value => value.toFixed(8)).join(",");
  const query = new URLSearchParams({
    assets: "MAP", width: String(LCM10_TILE_SIZE), height: String(LCM10_TILE_SIZE),
    rescale: "0,255", resampling: "nearest",
  });
  return `${SERVICE}/LCFM_LCM-10_V100_2020_${lat}${lon}_MAP/bbox/${bbox}.png?${query}`;
}

export function decodeLcm10Pixels(rgba: Uint8ClampedArray): LandCoverRaster {
  if (rgba.length !== LCM10_TILE_SIZE * LCM10_TILE_SIZE * 4) {
    throw new Error("LCM-10 returned an unexpected raster size.");
  }
  const pixels = new Uint8Array(rgba.length / 4);
  const mask = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    const offset = i * 4;
    if (rgba[offset + 3] === 0) continue;
    if (rgba[offset] !== rgba[offset + 1] || rgba[offset] !== rgba[offset + 2]) {
      throw new Error("LCM-10 returned styled imagery instead of classification values.");
    }
    pixels[i] = lcm10ClassToLandCover(rgba[offset]);
    mask[i] = pixels[i] ? 1 : 0;
  }
  return { width: LCM10_TILE_SIZE, pixels: [pixels], mask };
}

async function sourceItemExists(itemId: string): Promise<boolean> {
  return availability.getOrCreate(itemId, async () => {
    const query = new URLSearchParams({ collections: "lcfm-lcm-10", ids: itemId, limit: "1" });
    const response = await fetch(`https://stac.terrascope.be/search?${query}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`LCM-10 catalogue request failed (${response.status}).`);
    const result = await response.json() as { features?: { id: string }[] };
    if (!Array.isArray(result.features)) throw new Error("Invalid LCM-10 catalogue response.");
    return result.features.some(feature => feature.id === itemId);
  });
}

async function fetchTile(row: number, column: number): Promise<LandCoverRaster | undefined> {
  const url = lcm10TileRequest(row, column);
  const itemId = new URL(url).pathname.split("/items/")[1].split("/")[0];
  // The global catalogue omits many ocean tiles. Missing coverage is not bare land.
  if (!await sourceItemExists(itemId)) return undefined;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
  });
  // Handle a catalogue/raster deployment mismatch without aborting random selection.
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`LCM-10 tile request failed (${response.status}).`);
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: "none", premultiplyAlpha: "none",
  });
  try {
    if (bitmap.width !== LCM10_TILE_SIZE || bitmap.height !== LCM10_TILE_SIZE) {
      throw new Error("LCM-10 returned an unexpected raster size.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = LCM10_TILE_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("LCM-10 raster decoding requires a 2D canvas.");
    context.drawImage(bitmap, 0, 0);
    return decodeLcm10Pixels(context.getImageData(0, 0, canvas.width, canvas.height).data);
  } finally {
    bitmap.close();
  }
}

export async function fetchLcm10(bounds: TileBounds): Promise<Map<string, LandCoverRaster>> {
  const west = Math.max(-180, bounds.lonWest);
  const east = Math.min(180 - LCM10_RESOLUTION / 2, bounds.lonEast);
  const north = Math.min(83 - LCM10_RESOLUTION / 2, bounds.latNorth);
  const south = Math.max(-60 + LCM10_RESOLUTION / 2, bounds.latSouth);
  if (west > east || south > north) return new Map();
  const span = LCM10_TILE_SIZE * LCM10_RESOLUTION;
  const requests = mapGridRange(
    Math.floor((84 - north) / span), Math.floor((84 - south) / span),
    Math.floor((west + 180) / span), Math.floor((east + 180) / span),
    async (row, column): Promise<[string, LandCoverRaster | undefined]> => {
      const key = `${row}/${column}`;
      return [key, await cache.getOrCreate(key, () => fetchTile(row, column))];
    },
  );
  const tiles = await Promise.all(requests);
  return new Map(tiles.filter((entry): entry is [string, LandCoverRaster] => entry[1] !== undefined));
}
