import { TerrainResult, TileBounds } from "./TerrainTiles";
import * as Lerc from "lerc";

export enum LandCoverClass {
  TreeCover = 10,
  Shrubland = 20,
  Grassland = 30,
  Cropland = 40,
  BuiltUp = 50,
  Bare = 60,
  SnowAndIce = 70,
  Water = 80,
  Wetland = 90,
  Mangrove = 95,
  MossAndLichen = 100,
}

const TERRAIN_COLORS: Readonly<Record<number, readonly [number, number, number]>> = {
  [LandCoverClass.TreeCover]: [0.1, 0.34, 0.12],
  [LandCoverClass.Shrubland]: [0.36, 0.44, 0.18],
  [LandCoverClass.Grassland]: [0.42, 0.58, 0.22],
  [LandCoverClass.Cropland]: [0.57, 0.5, 0.25],
  [LandCoverClass.BuiltUp]: [0.42, 0.4, 0.38],
  [LandCoverClass.Bare]: [0.48, 0.45, 0.4],
  [LandCoverClass.SnowAndIce]: [0.92, 0.94, 0.96],
  [LandCoverClass.Water]: [0.05, 0.24, 0.42],
  [LandCoverClass.Wetland]: [0.16, 0.39, 0.32],
  [LandCoverClass.Mangrove]: [0.05, 0.32, 0.18],
  [LandCoverClass.MossAndLichen]: [0.56, 0.57, 0.42],
};

// Natural material tints used by the normal terrain renderer. These are kept
// separate from the brighter diagnostic palette above.
const SURFACE_COLORS: Readonly<Record<number, readonly [number, number, number]>> = {
  [LandCoverClass.TreeCover]: [0.42, 0.62, 0.32],
  [LandCoverClass.Shrubland]: [0.54, 0.66, 0.33],
  [LandCoverClass.Grassland]: [0.58, 0.76, 0.36],
  [LandCoverClass.Cropland]: [0.69, 0.68, 0.36],
  [LandCoverClass.BuiltUp]: [0.66, 0.64, 0.6],
  [LandCoverClass.Bare]: [0.7, 0.62, 0.5],
  [LandCoverClass.SnowAndIce]: [0.92, 0.95, 0.96],
  [LandCoverClass.Water]: [0.2, 0.38, 0.46],
  [LandCoverClass.Wetland]: [0.4, 0.61, 0.43],
  [LandCoverClass.Mangrove]: [0.32, 0.55, 0.34],
  [LandCoverClass.MossAndLichen]: [0.62, 0.68, 0.42],
};

export class WorldCover {
  private static readonly TILE_URL =
    "https://tiledimageservices.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/" +
    "European_Space_Agency_WorldCover_2020_Land_Cover_220202a/ImageServer/tile";
  private static readonly LEVEL = 14;
  private static readonly TILE_SIZE = 256;
  private static readonly RESOLUTION = 9.276623821756539;
  private static readonly ORIGIN_X = -20037507.0672;
  private static readonly ORIGIN_Y = 18807214.0967;
  private static readonly cache = new Map<string, Promise<Lerc.LercData>>();

  private constructor(
    private readonly tiles: Map<string, Lerc.LercData>,
    private readonly resolution: number,
  ) {}

  static async fetch(bounds: TileBounds, level = this.LEVEL): Promise<WorldCover> {
    await Lerc.load({
      locateFile: () => new URL("lerc-wasm.wasm", document.baseURI).toString(),
    });
    const clampedLevel = Math.max(0, Math.min(this.LEVEL, Math.round(level)));
    const resolution = this.RESOLUTION * Math.pow(2, this.LEVEL - clampedLevel);
    const northWest = this.tileFor(bounds.lonWest, bounds.latNorth, resolution);
    const southEast = this.tileFor(bounds.lonEast, bounds.latSouth, resolution);
    const requests: Array<Promise<readonly [string, Lerc.LercData]>> = [];
    for (let row = northWest.row; row <= southEast.row; row++) {
      for (let column = northWest.column; column <= southEast.column; column++) {
        requests.push(this.fetchTile(clampedLevel, row, column));
      }
    }
    return new WorldCover(new Map(await Promise.all(requests)), resolution);
  }

  sample(longitude: number, latitude: number): LandCoverClass {
    const { x, y } = toWebMercator(longitude, latitude);
    const pixelX = Math.floor((x - WorldCover.ORIGIN_X) / this.resolution);
    const pixelY = Math.floor((WorldCover.ORIGIN_Y - y) / this.resolution);
    return this.classAtPixel(pixelX, pixelY, LandCoverClass.Bare);
  }

  constrainElevations(
    terrain: TerrainResult,
    shorelineWidthMeters = 30,
    coastlineSmoothingMeters = 20,
  ): void {
    if (!terrain.bounds) return;
    const { bounds, elevations, width, height } = terrain;
    let coverage: Float32Array = new Float32Array(elevations.length);
    const water = new Uint8Array(elevations.length);
    const north = toWebMercator(0, bounds.latNorth).y;
    const south = toWebMercator(0, bounds.latSouth).y;
    const metersPerPixel = (
      (terrain.groundWidthMeters ?? shorelineWidthMeters * width / 8) / width +
      (terrain.groundHeightMeters ?? shorelineWidthMeters * height / 8) / height
    ) / 2;

    for (let y = 0; y < height; y++) {
      const v = y / (height - 1);
      const latitude = fromWebMercatorY(north + (south - north) * v);
      for (let x = 0; x < width; x++) {
        const longitude = bounds.lonWest + (bounds.lonEast - bounds.lonWest) * x / (width - 1);
        const index = y * width + x;
        coverage[index] = this.waterCoverage(longitude, latitude);
      }
    }

    const smoothingRadius = Math.max(1, Math.round(coastlineSmoothingMeters / metersPerPixel));
    coverage = smoothCoverage(coverage, width, height, smoothingRadius);
    for (let index = 0; index < water.length; index++) {
      water[index] = coverage[index] >= 0.5 ? 1 : 0;
    }

    const distance = distanceFromShore(water, width, height);
    const blendWidth = Math.max(1, shorelineWidthMeters / metersPerPixel);
    const clearance = 0.25;

    terrain.minElevation = Infinity;
    terrain.maxElevation = -Infinity;
    for (let index = 0; index < elevations.length; index++) {
      const shorelineElevation = clearance * (1 - 2 * coverage[index]);
      const corrected = water[index]
        ? Math.min(elevations[index], -clearance)
        : Math.max(elevations[index], clearance);
      const amount = Math.min(1, distance[index] / blendWidth);
      const blend = amount * amount * (3 - 2 * amount);
      elevations[index] = shorelineElevation + (corrected - shorelineElevation) * blend;
      terrain.minElevation = Math.min(terrain.minElevation, elevations[index]);
      terrain.maxElevation = Math.max(terrain.maxElevation, elevations[index]);
    }
  }

  private waterCoverage(longitude: number, latitude: number): number {
    const { x, y } = toWebMercator(longitude, latitude);
    const pixelX = (x - WorldCover.ORIGIN_X) / this.resolution - 0.5;
    const pixelY = (WorldCover.ORIGIN_Y - y) / this.resolution - 0.5;
    const x0 = Math.floor(pixelX);
    const y0 = Math.floor(pixelY);
    const fx = pixelX - x0;
    const fy = pixelY - y0;
    const fallback = this.sample(longitude, latitude);
    const waterAt = (px: number, py: number): number =>
      this.classAtPixel(px, py, fallback) === LandCoverClass.Water ? 1 : 0;
    const top = waterAt(x0, y0) * (1 - fx) + waterAt(x0 + 1, y0) * fx;
    const bottom = waterAt(x0, y0 + 1) * (1 - fx) + waterAt(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  }

  private classAtPixel(pixelX: number, pixelY: number, fallback: LandCoverClass): LandCoverClass {
    const column = Math.floor(pixelX / WorldCover.TILE_SIZE);
    const row = Math.floor(pixelY / WorldCover.TILE_SIZE);
    const tile = this.tiles.get(`${row}/${column}`);
    if (!tile) return fallback;
    const x = pixelX - column * WorldCover.TILE_SIZE;
    const y = pixelY - row * WorldCover.TILE_SIZE;
    const index = y * tile.width + x;
    return (!tile.mask || tile.mask[index] ? tile.pixels[0][index] : fallback) as LandCoverClass;
  }

  private static tileFor(
    longitude: number,
    latitude: number,
    resolution: number,
  ): { row: number; column: number } {
    const { x, y } = toWebMercator(longitude, latitude);
    const span = this.TILE_SIZE * resolution;
    return {
      row: Math.floor((this.ORIGIN_Y - y) / span),
      column: Math.floor((x - this.ORIGIN_X) / span),
    };
  }

  private static async fetchTile(
    level: number,
    row: number,
    column: number,
  ): Promise<readonly [string, Lerc.LercData]> {
    const tileKey = `${row}/${column}`;
    const cacheKey = `${level}/${tileKey}`;
    let request = this.cache.get(cacheKey);
    if (!request) {
      request = fetch(`${this.TILE_URL}/${cacheKey}`, {
        signal: AbortSignal.timeout(15_000),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`WorldCover tile request failed (${response.status}).`);
        return Lerc.decode(await response.arrayBuffer());
      }).catch((error: unknown) => {
        this.cache.delete(cacheKey);
        throw error;
      });
      this.cache.set(cacheKey, request);
    }
    return [tileKey, await request];
  }
}

export function landCoverColor(landCover: LandCoverClass): readonly [number, number, number] {
  return TERRAIN_COLORS[landCover] ?? TERRAIN_COLORS[LandCoverClass.Bare];
}

export function landCoverSurfaceColor(
  landCover: LandCoverClass,
): readonly [number, number, number] {
  return SURFACE_COLORS[landCover] ?? SURFACE_COLORS[LandCoverClass.Bare];
}

function toWebMercator(longitude: number, latitude: number): { x: number; y: number } {
  const radius = 6_378_137;
  const clampedLatitude = Math.min(85.05112878, Math.max(-85.05112878, latitude));
  return {
    x: radius * longitude * Math.PI / 180,
    y: radius * Math.log(Math.tan(Math.PI / 4 + clampedLatitude * Math.PI / 360)),
  };
}

function fromWebMercatorY(y: number): number {
  return Math.atan(Math.sinh(y / 6_378_137)) * 180 / Math.PI;
}

function smoothCoverage(
  source: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  let result = source;
  for (let pass = 0; pass < 2; pass++) {
    const horizontal = new Float32Array(source.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;
        for (let offset = -radius; offset <= radius; offset++) {
          const sampleX = x + offset;
          if (sampleX < 0 || sampleX >= width) continue;
          sum += result[y * width + sampleX];
          count++;
        }
        horizontal[y * width + x] = sum / count;
      }
    }

    const vertical = new Float32Array(source.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;
        for (let offset = -radius; offset <= radius; offset++) {
          const sampleY = y + offset;
          if (sampleY < 0 || sampleY >= height) continue;
          sum += horizontal[sampleY * width + x];
          count++;
        }
        vertical[y * width + x] = sum / count;
      }
    }
    result = vertical;
  }
  return result;
}

function distanceFromShore(water: Uint8Array, width: number, height: number): Float32Array {
  const distance = new Float32Array(water.length).fill(Infinity);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (
        (x > 0 && water[index - 1] !== water[index]) ||
        (x + 1 < width && water[index + 1] !== water[index]) ||
        (y > 0 && water[index - width] !== water[index]) ||
        (y + 1 < height && water[index + width] !== water[index])
      ) distance[index] = 0.5;
    }
  }

  distancePass(distance, width, height, false);
  distancePass(distance, width, height, true);
  return distance;
}

function distancePass(distance: Float32Array, width: number, height: number, reverse: boolean): void {
  const diagonal = Math.SQRT2;
  for (let row = 0; row < height; row++) {
    const y = reverse ? height - 1 - row : row;
    for (let column = 0; column < width; column++) {
      const x = reverse ? width - 1 - column : column;
      const index = y * width + x;
      const horizontal = x + (reverse ? 1 : -1);
      const vertical = y + (reverse ? 1 : -1);
      if (horizontal >= 0 && horizontal < width) {
        distance[index] = Math.min(distance[index], distance[y * width + horizontal] + 1);
      }
      if (vertical >= 0 && vertical < height) {
        distance[index] = Math.min(distance[index], distance[vertical * width + x] + 1);
        if (horizontal >= 0 && horizontal < width) {
          distance[index] = Math.min(distance[index], distance[vertical * width + horizontal] + diagonal);
        }
        const otherHorizontal = x + (reverse ? -1 : 1);
        if (otherHorizontal >= 0 && otherHorizontal < width) {
          distance[index] = Math.min(distance[index], distance[vertical * width + otherHorizontal] + diagonal);
        }
      }
    }
  }
}
