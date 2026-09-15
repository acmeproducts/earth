import type { TerrainData } from "../terrain/TerrainData";
import { ResourceCache } from "../core/ResourceCache";
import type { TileBounds } from "./WorldGrid";
import { shapeCoastlineElevations } from "../water/Coastline";
import { SUBMERGED_TERRAIN_CEILING_METERS } from "./Geo";
import * as Lerc from "lerc";
import { SimplexNoise2D } from "../core/SimplexNoise";

const tintBoundaryNoise = new SimplexNoise2D(0x47524153);

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

export interface LandCoverSampler {
  sample(longitude: number, latitude: number): LandCoverClass;
  /** Optional continuous surface tint for renderers that soften class edges. */
  sampleSurfaceColor?(
    longitude: number,
    latitude: number,
  ): readonly [number, number, number];
}

// Natural material tints used by the terrain renderer.
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

const COASTLINE_LAND_BLEND_METERS = 80;
const COASTLINE_WATER_BLEND_METERS = 160;
const COASTLINE_SMOOTHING_METERS = 40;
// Two smoothing passes can move the classified shore by twice their radius.
const COASTLINE_CONTEXT_METERS =
  COASTLINE_WATER_BLEND_METERS + COASTLINE_SMOOTHING_METERS * 2;

export class WorldCover {
  private static readonly TILE_URL =
    "https://tiledimageservices.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/" +
    "European_Space_Agency_WorldCover_2021_Land_Cover_WGS84_7/ImageServer/tile";
  private static readonly LEVEL = 13;
  private static readonly TILE_SIZE = 256;
  private static readonly RESOLUTION = 1 / 12_000;
  private static readonly ORIGIN_X = -180;
  private static readonly ORIGIN_Y = 84;
  private static readonly MIN_LONGITUDE = -180;
  private static readonly MAX_LONGITUDE = 180;
  private static readonly MIN_LATITUDE = -60;
  private static readonly MAX_LATITUDE = 84;
  private static readonly cache = new ResourceCache<Lerc.LercData>(16 * 1024 * 1024,
    (tile) => tile.pixels.reduce((bytes, pixels) => bytes + pixels.byteLength, 0) +
      (tile.mask?.byteLength ?? 0));
  private static decoderReady?: Promise<void>;

  private constructor(
    private readonly tiles: Map<string, Lerc.LercData>,
    private readonly resolution: number,
  ) {}

  static async fetch(bounds: TileBounds, level = this.LEVEL): Promise<WorldCover> {
    await this.loadDecoder();
    const clampedLevel = Math.max(0, Math.min(this.LEVEL, Math.round(level)));
    const resolution = this.RESOLUTION * Math.pow(2, this.LEVEL - clampedLevel);
    const west = Math.max(this.MIN_LONGITUDE, bounds.lonWest);
    const east = Math.min(this.MAX_LONGITUDE - resolution / 2, bounds.lonEast);
    const north = Math.min(this.MAX_LATITUDE - resolution / 2, bounds.latNorth);
    const south = Math.max(this.MIN_LATITUDE + resolution / 2, bounds.latSouth);
    if (west > east || south > north) return new WorldCover(new Map(), resolution);
    const northWest = this.tileFor(west, north, resolution);
    const southEast = this.tileFor(east, south, resolution);
    const requests: Array<Promise<readonly [string, Lerc.LercData]>> = [];
    for (let row = northWest.row; row <= southEast.row; row++) {
      for (let column = northWest.column; column <= southEast.column; column++) {
        requests.push(this.fetchTile(clampedLevel, row, column));
      }
    }
    return new WorldCover(new Map(await Promise.all(requests)), resolution);
  }

  /** Loads enough classification around a terrain tile to shape shared edges consistently. */
  static fetchForTerrain(terrain: TerrainData): Promise<WorldCover> {
    const sampleMargin = Math.max(
      terrain.groundWidthMeters / Math.max(1, terrain.width - 1),
      terrain.groundHeightMeters / Math.max(1, terrain.height - 1),
    );
    return this.fetch(expandTerrainBounds(
      terrain,
      COASTLINE_CONTEXT_METERS + sampleMargin,
    ));
  }

  sample(longitude: number, latitude: number): LandCoverClass {
    const pixelX = Math.floor((longitude - WorldCover.ORIGIN_X) / this.resolution);
    const pixelY = Math.floor((WorldCover.ORIGIN_Y - latitude) / this.resolution);
    return this.classAtPixel(pixelX, pixelY, LandCoverClass.Bare);
  }

  /**
   * Blends neighboring pixels with a soft cubic filter and gently warped edges.
   * Classification remains discrete for placement and collision decisions,
   * but visual layers can cross a land-cover boundary without exposing the
   * source raster grid.
   */
  sampleSurfaceColor(
    longitude: number,
    latitude: number,
  ): readonly [number, number, number] {
    // Pixel coordinates refer to cell corners; subtracting half a pixel makes
    // the integer sample positions land on the source pixels' centres.
    const sourceX = (longitude - WorldCover.ORIGIN_X) / this.resolution;
    const sourceY = (WorldCover.ORIGIN_Y - latitude) / this.resolution;
    // Anchor the warp to the source grid so adjacent terrain tiles agree.
    const pixelX = sourceX - 0.5 +
      tintBoundaryNoise.sample(sourceX / 6, sourceY / 6) * 0.65;
    const pixelY = sourceY - 0.5 +
      tintBoundaryNoise.sample(sourceX / 6 + 73, sourceY / 6 - 41) * 0.65;
    const x0 = Math.floor(pixelX);
    const y0 = Math.floor(pixelY);
    const fx = pixelX - x0;
    const fy = pixelY - y0;
    const fallback = this.sample(longitude, latitude);
    const colorAt = (x: number, y: number): readonly [number, number, number] =>
      landCoverSurfaceColor(this.classAtPixel(x, y, fallback));
    // Positive B-spline weights soften the gradient without overshooting the
    // palette or leaving a crease at each source pixel centre.
    const weights = (t: number): readonly number[] => [
      (1 - t) ** 3 / 6,
      (3 * t ** 3 - 6 * t * t + 4) / 6,
      (-3 * t ** 3 + 3 * t * t + 3 * t + 1) / 6,
      t ** 3 / 6,
    ];
    const wx = weights(fx);
    const wy = weights(fy);
    const color: [number, number, number] = [0, 0, 0];
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        const sample = colorAt(x0 + column - 1, y0 + row - 1);
        const weight = wx[column] * wy[row];
        for (let channel = 0; channel < 3; channel++) {
          color[channel] += sample[channel] * weight;
        }
      }
    }
    return color;
  }

  async constrainElevations(
    terrain: TerrainData,
    shorelineWidthMeters = COASTLINE_LAND_BLEND_METERS,
    coastlineSmoothingMeters = COASTLINE_SMOOTHING_METERS,
    yieldControl?: () => Promise<void>,
  ): Promise<void> {
    const { bounds, width, height } = terrain;
    const metersPerPixelX = terrain.groundWidthMeters / Math.max(1, width - 1);
    const metersPerPixelY = terrain.groundHeightMeters / Math.max(1, height - 1);
    const waterBlendWidthMeters = shorelineWidthMeters * 2;
    const contextMeters = waterBlendWidthMeters + coastlineSmoothingMeters * 2;
    const haloX = Math.ceil(contextMeters / metersPerPixelX);
    const haloY = Math.ceil(contextMeters / metersPerPixelY);
    const sampleWidth = width + haloX * 2;
    const sampleHeight = height + haloY * 2;
    let coverage: Float32Array<ArrayBufferLike> = new Float32Array(sampleWidth * sampleHeight);
    const water = new Uint8Array(coverage.length);
    const north = toWebMercator(0, bounds.latNorth).y;
    const south = toWebMercator(0, bounds.latSouth).y;
    let hasWaterCoverage = false;

    for (let y = 0; y < sampleHeight; y++) {
      const v = (y - haloY) / (height - 1);
      const latitude = fromWebMercatorY(north + (south - north) * v);
      for (let x = 0; x < sampleWidth; x++) {
        const u = (x - haloX) / (width - 1);
        const longitude = bounds.lonWest + (bounds.lonEast - bounds.lonWest) * u;
        const index = y * sampleWidth + x;
        coverage[index] = this.waterCoverage(longitude, latitude);
        if (coverage[index] !== 0) hasWaterCoverage = true;
      }
      await yieldControl?.();
    }

    const smoothingRadiusX = Math.max(
      1,
      Math.round(coastlineSmoothingMeters / metersPerPixelX),
    );
    const smoothingRadiusY = Math.max(
      1,
      Math.round(coastlineSmoothingMeters / metersPerPixelY),
    );
    // An entirely dry padded grid stays zero through both smoothing passes.
    coverage = hasWaterCoverage ? await smoothCoverage(
      coverage,
      sampleWidth,
      sampleHeight,
      smoothingRadiusX,
      smoothingRadiusY,
      yieldControl,
    ) : coverage;
    for (let index = 0; index < water.length; index++) {
      water[index] = coverage[index] >= 0.5 ? 1 : 0;
      if ((index & 4095) === 4095) await yieldControl?.();
    }
    // Retain the terrain-aligned crop so bridge clearance and coastline
    // shaping use the same water classification.
    terrain.waterMask = cropWaterMask(
      water,
      sampleWidth,
      width,
      height,
      haloX,
      haloY,
    );

    await shapeCoastlineElevations(
      terrain,
      {
        coverage,
        water,
        width: sampleWidth,
        height: sampleHeight,
        terrainOffsetX: haloX,
        terrainOffsetY: haloY,
      },
      {
        metersPerPixelX,
        metersPerPixelY,
        landBlendWidthMeters: shorelineWidthMeters,
        // The submerged side needs more room to reach the deep-water ceiling;
        // otherwise that safety depth is itself rendered as a coastal wall.
        waterBlendWidthMeters,
        deepWaterCeilingMeters: SUBMERGED_TERRAIN_CEILING_METERS,
      },
      yieldControl,
    );
  }

  private waterCoverage(longitude: number, latitude: number): number {
    const pixelX = (longitude - WorldCover.ORIGIN_X) / this.resolution - 0.5;
    const pixelY = (WorldCover.ORIGIN_Y - latitude) / this.resolution - 0.5;
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
    const span = this.TILE_SIZE * resolution;
    return {
      row: Math.floor((this.ORIGIN_Y - latitude) / span),
      column: Math.floor((longitude - this.ORIGIN_X) / span),
    };
  }

  private static async fetchTile(
    level: number,
    row: number,
    column: number,
  ): Promise<readonly [string, Lerc.LercData]> {
    const tileKey = `${row}/${column}`;
    const cacheKey = `${level}/${tileKey}`;
    const request = this.cache.getOrCreate(cacheKey, () =>
      fetch(`${this.TILE_URL}/${cacheKey}`, {
        signal: AbortSignal.timeout(15_000),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`WorldCover tile request failed (${response.status}).`);
        return Lerc.decode(await response.arrayBuffer());
      }));
    return [tileKey, await request];
  }

  private static loadDecoder(): Promise<void> {
    if (!this.decoderReady) {
      this.decoderReady = Lerc.load({
        locateFile: () => new URL("lerc-wasm.wasm", document.baseURI).toString(),
      }).catch((error: unknown) => {
        this.decoderReady = undefined;
        throw error;
      });
    }
    return this.decoderReady;
  }
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

async function smoothCoverage(
  source: Float32Array,
  width: number,
  height: number,
  radiusX: number,
  radiusY: number,
  yieldControl?: () => Promise<void>,
): Promise<Float32Array> {
  let result = source;
  for (let pass = 0; pass < 2; pass++) {
    const horizontal = new Float32Array(source.length);
    const rowPrefix = new Float64Array(width + 1);
    for (let y = 0; y < height; y++) {
      rowPrefix[0] = 0;
      for (let x = 0; x < width; x++) {
        rowPrefix[x + 1] = rowPrefix[x] + result[y * width + x];
      }
      for (let x = 0; x < width; x++) {
        const start = Math.max(0, x - radiusX);
        const end = Math.min(width, x + radiusX + 1);
        horizontal[y * width + x] = (rowPrefix[end] - rowPrefix[start]) / (end - start);
      }
      await yieldControl?.();
    }

    const vertical = new Float32Array(source.length);
    const columnPrefix = new Float64Array(height + 1);
    for (let x = 0; x < width; x++) {
      columnPrefix[0] = 0;
      for (let y = 0; y < height; y++) {
        columnPrefix[y + 1] = columnPrefix[y] + horizontal[y * width + x];
      }
      for (let y = 0; y < height; y++) {
        const start = Math.max(0, y - radiusY);
        const end = Math.min(height, y + radiusY + 1);
        vertical[y * width + x] = (columnPrefix[end] - columnPrefix[start]) / (end - start);
      }
      await yieldControl?.();
    }
    result = vertical;
  }
  return result;
}

function cropWaterMask(
  source: Uint8Array,
  sourceWidth: number,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
): Uint8Array {
  const result = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    result.set(
      source.subarray(
        (y + offsetY) * sourceWidth + offsetX,
        (y + offsetY) * sourceWidth + offsetX + width,
      ),
      y * width,
    );
  }
  return result;
}

function expandTerrainBounds(terrain: TerrainData, paddingMeters: number): TileBounds {
  const longitudePadding =
    (terrain.bounds.lonEast - terrain.bounds.lonWest) *
    paddingMeters /
    terrain.groundWidthMeters;
  const north = toWebMercator(0, terrain.bounds.latNorth).y;
  const south = toWebMercator(0, terrain.bounds.latSouth).y;
  const projectedPadding = (north - south) * paddingMeters / terrain.groundHeightMeters;
  return {
    lonWest: Math.max(-180, terrain.bounds.lonWest - longitudePadding),
    lonEast: Math.min(180, terrain.bounds.lonEast + longitudePadding),
    latNorth: Math.min(85.05112878, fromWebMercatorY(north + projectedPadding)),
    latSouth: Math.max(-85.05112878, fromWebMercatorY(south - projectedPadding)),
  };
}
