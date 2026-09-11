import { groundMetersAt, SEA_LEVEL_METERS } from "./Geo";
import { clamp, lerp, resolvableBandWeight, smoothstep } from "./MathUtils";
import { SimplexNoise2D } from "./SimplexNoise";
import type { TerrainData } from "./TerrainData";
import { LandCoverClass } from "./WorldCover";
import type { LandCoverSampler } from "./WorldCover";
import { DEFAULT_WORLD_SEED, layerSeed } from "./WorldGrid";

/**
 * Procedural relief below the resolution of the elevation provider.
 *
 * The source DEM samples the ground every 30 m or so and the provider
 * upsamples it bilinearly, so everything between real samples is a plane. The
 * hummocks, hollows, ledges and tussocks between 5 m and 150 m — the band the
 * eye reads as natural ground — are simply absent, and the texture layers,
 * which stop at a 10 m repeat, cannot fill it. This pass displaces the
 * elevation raster itself before shorelines, lakes, roads and building pads
 * are shaped, so the mesh, the collision height and every vegetation
 * placement see one and the same ground.
 *
 * Every field is anchored to ground metres and seeded from the world, like the
 * habitat and ground-colour fields, so a hummock crosses a tile edge intact and
 * neighbouring tiles agree on their shared samples.
 */

export interface TerrainReliefBand {
  /** Wavelength in metres of ground. */
  meters: number;
  /** Peak displacement on flat, fully receptive ground. */
  amplitudeMeters: number;
  /** Extra amplitude on broken ground, as a multiple of the base amplitude. */
  slopeGain: number;
  /** Sharpen into crests as the ground steepens, the way broken rock does. */
  ridged: boolean;
}

export const TERRAIN_RELIEF_BANDS: readonly TerrainReliefBand[] = [
  // Hummocks and hollows the DEM is too coarse to carry.
  { meters: 110, amplitudeMeters: 0.8, slopeGain: 0, ridged: false },
  // Ledges, terracettes and broken ground; strongest on slopes.
  { meters: 22, amplitudeMeters: 0.35, slopeGain: 1.5, ridged: true },
  // Tussocks and root mounds; only native tiles have vertices for it.
  { meters: 6.5, amplitudeMeters: 0.1, slopeGain: 0.5, ridged: false },
];

/** Bends the sample coordinates so the relief flows instead of reading as noise. */
const WARP = { meters: 160, amplitudeMeters: 18 };

/** Baseline for measuring slope, near the real resolution of the source DEM. */
const SLOPE_BASELINE_METERS = 12;
/** Rise over run between which ground turns from soft to broken. */
const GENTLE_SLOPE = 0.08;
const BROKEN_SLOPE = 0.5;

/** Relief fades out approaching the sea so shorelines keep their profile. */
const SHORE_FADE_START_METERS = 0.5;
const SHORE_FADE_END_METERS = 3;

/** Land-cover edges are hard; relief strength blends across this distance. */
const STRENGTH_BLEND_METERS = 20;

/**
 * How much relief each surface accepts. Engineered, wet and frozen ground lies
 * flatter than soil under vegetation; bare ground is the most broken of all.
 */
const RELIEF_STRENGTH: Readonly<Record<number, number>> = {
  [LandCoverClass.Water]: 0,
  [LandCoverClass.Mangrove]: 0.2,
  [LandCoverClass.Wetland]: 0.25,
  [LandCoverClass.BuiltUp]: 0.3,
  [LandCoverClass.Cropland]: 0.45,
  [LandCoverClass.SnowAndIce]: 0.55,
  [LandCoverClass.Grassland]: 0.7,
  [LandCoverClass.Shrubland]: 0.9,
  [LandCoverClass.MossAndLichen]: 0.9,
  [LandCoverClass.TreeCover]: 1,
  [LandCoverClass.Bare]: 1.25,
};

export interface TerrainDetailOptions {
  /**
   * Spacing of the mesh vertices that will sample this raster, in metres.
   * Bands the mesh cannot reconstruct are faded out instead of aliasing.
   */
  meshVertexSpacingMeters: number;
  landCover?: LandCoverSampler;
  worldSeed?: number;
}

/**
 * Raises the raster resolution so the relief has vertices to live on.
 *
 * Bilinear interpolation reproduces exactly the surface the mesh already
 * rendered between samples, so on its own this changes nothing visible; the
 * relief pass supplies everything new. Call it before shoreline
 * classification: the water mask and shore distances are raster-aligned and
 * are not resampled here.
 */
export function upsampleTerrain(terrain: TerrainData, factor: number): TerrainData {
  const scale = Math.max(1, Math.round(factor));
  if (scale === 1) return terrain;
  if (terrain.waterMask || terrain.shoreDistanceMeters) {
    throw new Error("Terrain must be upsampled before its shoreline is classified.");
  }
  const width = (terrain.width - 1) * scale + 1;
  const height = (terrain.height - 1) * scale + 1;
  const elevations = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sourceY = y / scale;
    const y0 = Math.min(Math.floor(sourceY), terrain.height - 1);
    const y1 = Math.min(y0 + 1, terrain.height - 1);
    const fractionY = sourceY - y0;
    for (let x = 0; x < width; x++) {
      const sourceX = x / scale;
      const x0 = Math.min(Math.floor(sourceX), terrain.width - 1);
      const x1 = Math.min(x0 + 1, terrain.width - 1);
      const fractionX = sourceX - x0;
      const north = lerp(
        terrain.elevations[y0 * terrain.width + x0],
        terrain.elevations[y0 * terrain.width + x1],
        fractionX,
      );
      const south = lerp(
        terrain.elevations[y1 * terrain.width + x0],
        terrain.elevations[y1 * terrain.width + x1],
        fractionX,
      );
      elevations[y * width + x] = lerp(north, south, fractionY);
    }
  }
  return { ...terrain, elevations, width, height };
}

/** Displaces the elevation raster with world-anchored relief. */
export async function applyTerrainDetail(
  terrain: TerrainData,
  options: TerrainDetailOptions,
  yieldControl?: () => Promise<void>,
): Promise<void> {
  const { width, height, elevations } = terrain;
  if (width < 2 || height < 2) return;
  const weights = TERRAIN_RELIEF_BANDS.map((band) =>
    resolvableBandWeight(band.meters, options.meshVertexSpacingMeters));
  if (weights.every((weight) => weight <= 0)) return;

  const fields = reliefFields(options.worldSeed ?? DEFAULT_WORLD_SEED);
  const steepness = await steepnessField(terrain, yieldControl);
  const strength = await reliefStrengthField(terrain, options.landCover, yieldControl);

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const index = row * width + column;
      const elevation = elevations[index];
      const receptivity = strength[index] * smoothstep(
        SEA_LEVEL_METERS + SHORE_FADE_START_METERS,
        SEA_LEVEL_METERS + SHORE_FADE_END_METERS,
        elevation,
      );
      if (receptivity <= 0) continue;
      const { longitude, latitude } = rasterLocation(terrain, column, row);
      const ground = groundMetersAt(longitude, latitude);
      elevations[index] = elevation +
        receptivity * reliefAt(fields, ground.x, ground.y, steepness[index], weights);
    }
    await yieldControl?.();
  }

  terrain.minElevation = Infinity;
  terrain.maxElevation = -Infinity;
  for (const elevation of elevations) {
    terrain.minElevation = Math.min(terrain.minElevation, elevation);
    terrain.maxElevation = Math.max(terrain.maxElevation, elevation);
  }
}

interface ReliefFields {
  warpX: SimplexNoise2D;
  warpY: SimplexNoise2D;
  bands: readonly SimplexNoise2D[];
}

/**
 * Built once per world rather than held in a module constant, so re-rolling
 * the world seed re-rolls the ground with everything else.
 */
const fieldsBySeed = new Map<number, ReliefFields>();

function reliefFields(worldSeed: number): ReliefFields {
  let fields = fieldsBySeed.get(worldSeed);
  if (!fields) {
    fields = {
      warpX: new SimplexNoise2D(layerSeed(worldSeed, "terrainRelief/warpX")),
      warpY: new SimplexNoise2D(layerSeed(worldSeed, "terrainRelief/warpY")),
      bands: TERRAIN_RELIEF_BANDS.map((band) => new SimplexNoise2D(
        layerSeed(worldSeed, `terrainRelief/${band.meters}`),
      )),
    };
    fieldsBySeed.set(worldSeed, fields);
  }
  return fields;
}

/** Relief in metres at a ground position, before surface receptivity. */
function reliefAt(
  fields: ReliefFields,
  groundX: number,
  groundY: number,
  steepness: number,
  weights: readonly number[],
): number {
  const warpedX = groundX +
    fields.warpX.sample(groundX / WARP.meters, groundY / WARP.meters) * WARP.amplitudeMeters;
  const warpedY = groundY +
    fields.warpY.sample(groundX / WARP.meters, groundY / WARP.meters) * WARP.amplitudeMeters;
  let relief = 0;
  for (let index = 0; index < TERRAIN_RELIEF_BANDS.length; index++) {
    const weight = weights[index];
    if (weight <= 0) continue;
    const band = TERRAIN_RELIEF_BANDS[index];
    let value = fields.bands[index].sample(warpedX / band.meters, warpedY / band.meters);
    if (band.ridged) {
      // Folding the field about zero turns its smooth zero crossings into
      // sharp crests; the offset keeps the folded field centred.
      value = lerp(value, clamp(0.5 - 2 * Math.abs(value), -1, 1), steepness);
    }
    relief += value * band.amplitudeMeters * (1 + band.slopeGain * steepness) * weight;
  }
  return relief;
}

/**
 * Zero on gentle ground rising to one on broken slopes, measured over a
 * baseline near the source DEM's own resolution so provider upsampling does
 * not read as flat.
 */
async function steepnessField(
  terrain: TerrainData,
  yieldControl?: () => Promise<void>,
): Promise<Float32Array> {
  const { width, height, elevations } = terrain;
  const metersPerSampleX = terrain.groundWidthMeters / (width - 1);
  const metersPerSampleY = terrain.groundHeightMeters / (height - 1);
  const stepX = Math.max(1, Math.round(SLOPE_BASELINE_METERS / metersPerSampleX));
  const stepY = Math.max(1, Math.round(SLOPE_BASELINE_METERS / metersPerSampleY));
  const steepness = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const north = Math.max(0, row - stepY);
    const south = Math.min(height - 1, row + stepY);
    const runY = (south - north) * metersPerSampleY;
    for (let column = 0; column < width; column++) {
      const west = Math.max(0, column - stepX);
      const east = Math.min(width - 1, column + stepX);
      const runX = (east - west) * metersPerSampleX;
      const slope = Math.hypot(
        (elevations[row * width + east] - elevations[row * width + west]) / runX,
        (elevations[south * width + column] - elevations[north * width + column]) / runY,
      );
      steepness[row * width + column] = smoothstep(GENTLE_SLOPE, BROKEN_SLOPE, slope);
    }
    await yieldControl?.();
  }
  return steepness;
}

/**
 * Per-sample relief strength from land cover, blended across class edges.
 *
 * Land-cover classes change at hard raster edges, and a step in relief
 * amplitude along such an edge would read as a fault line. The classes are
 * sampled on a halo wider than the blend so the blur has real neighbours at
 * the tile boundary and adjacent tiles compute identical strengths there.
 */
async function reliefStrengthField(
  terrain: TerrainData,
  landCover: LandCoverSampler | undefined,
  yieldControl?: () => Promise<void>,
): Promise<Float32Array> {
  const { width, height } = terrain;
  if (!landCover) return new Float32Array(width * height).fill(1);

  const haloX = Math.max(1, Math.round(
    STRENGTH_BLEND_METERS / (terrain.groundWidthMeters / (width - 1)),
  ));
  const haloY = Math.max(1, Math.round(
    STRENGTH_BLEND_METERS / (terrain.groundHeightMeters / (height - 1)),
  ));
  const paddedWidth = width + haloX * 2;
  const paddedHeight = height + haloY * 2;
  const padded = new Float32Array(paddedWidth * paddedHeight);
  for (let row = 0; row < paddedHeight; row++) {
    for (let column = 0; column < paddedWidth; column++) {
      const { longitude, latitude } = rasterLocation(terrain, column - haloX, row - haloY);
      padded[row * paddedWidth + column] =
        RELIEF_STRENGTH[landCover.sample(longitude, latitude)] ?? 1;
    }
    await yieldControl?.();
  }
  return boxBlurInterior(padded, paddedWidth, paddedHeight, haloX, haloY);
}

/**
 * Separable box blur of a padded grid, returning only its interior. The blur
 * radius equals the padding, so every window stays inside the padded grid.
 */
function boxBlurInterior(
  padded: Float32Array,
  paddedWidth: number,
  paddedHeight: number,
  radiusX: number,
  radiusY: number,
): Float32Array {
  const width = paddedWidth - radiusX * 2;
  const height = paddedHeight - radiusY * 2;
  const horizontal = new Float32Array(width * paddedHeight);
  const rowPrefix = new Float64Array(paddedWidth + 1);
  for (let row = 0; row < paddedHeight; row++) {
    for (let column = 0; column < paddedWidth; column++) {
      rowPrefix[column + 1] = rowPrefix[column] + padded[row * paddedWidth + column];
    }
    for (let column = 0; column < width; column++) {
      horizontal[row * width + column] =
        (rowPrefix[column + radiusX * 2 + 1] - rowPrefix[column]) / (radiusX * 2 + 1);
    }
  }
  const result = new Float32Array(width * height);
  const columnPrefix = new Float64Array(paddedHeight + 1);
  for (let column = 0; column < width; column++) {
    for (let row = 0; row < paddedHeight; row++) {
      columnPrefix[row + 1] = columnPrefix[row] + horizontal[row * width + column];
    }
    for (let row = 0; row < height; row++) {
      result[row * width + column] =
        (columnPrefix[row + radiusY * 2 + 1] - columnPrefix[row]) / (radiusY * 2 + 1);
    }
  }
  return result;
}

/**
 * Geographic position of a raster sample. Rows are spaced evenly in Web
 * Mercator, matching how the terrain mesh maps its vertices, and the mapping
 * extends past the raster so halo samples land where the neighbour's would.
 */
function rasterLocation(
  terrain: TerrainData,
  column: number,
  row: number,
): { longitude: number; latitude: number } {
  const { bounds } = terrain;
  const u = column / (terrain.width - 1);
  const v = row / (terrain.height - 1);
  const north = mercatorY(bounds.latNorth);
  const projectedY = north - v * (north - mercatorY(bounds.latSouth));
  return {
    longitude: bounds.lonWest + u * (bounds.lonEast - bounds.lonWest),
    latitude: Math.atan(Math.sinh(projectedY)) * 180 / Math.PI,
  };
}

function mercatorY(latitude: number): number {
  return Math.asinh(Math.tan(latitude * Math.PI / 180));
}
