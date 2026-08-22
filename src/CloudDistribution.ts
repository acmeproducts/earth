export const CLOUD_CELL_SIZE_METERS = 8_000;
export const CLOUD_VARIANT_COUNT = 8;

const CLOUD_ALTITUDE_METERS = 5_000;
const CLOUD_WIDTH_MIN_METERS = 10_000;
const CLOUD_WIDTH_MAX_METERS = 18_000;
const CLOUD_HEIGHT_MIN_METERS = 3_000;
const CLOUD_HEIGHT_MAX_METERS = 5_000;

export type CloudWeatherKind = "clear" | "sparse" | "scattered" | "dense";

export interface CloudWeatherProfile {
  readonly kind: CloudWeatherKind;
  readonly occupancy: number;
  readonly sizeScale: number;
}

interface WeightedCloudWeatherProfile extends CloudWeatherProfile {
  readonly weight: number;
}

// Ordinary scattered skies dominate. Clear and dense extremes are deliberately rare.
const CLOUD_WEATHER_PROFILES: readonly WeightedCloudWeatherProfile[] = [
  { kind: "clear", weight: 14, occupancy: 0, sizeScale: 1 },
  { kind: "sparse", weight: 32, occupancy: 0.18, sizeScale: 0.85 },
  { kind: "scattered", weight: 42, occupancy: 0.42, sizeScale: 1 },
  { kind: "dense", weight: 12, occupancy: 0.7, sizeScale: 1.3 },
];

export interface CloudPlacement {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  variant: number;
  mirrored: boolean;
}

/** Deterministic placements in the cloud field's own world-scale lattice. */
export function cloudPlacementsAround(
  centerCellX: number,
  centerCellZ: number,
  visibleRadiusMeters: number,
  metersPerUnit: number,
  weatherSeed: number,
): CloudPlacement[] {
  const weather = cloudWeatherForSeed(weatherSeed);
  if (weather.occupancy === 0) return [];
  const radiusCells = Math.ceil(visibleRadiusMeters / CLOUD_CELL_SIZE_METERS) + 1;
  const placements: CloudPlacement[] = [];
  for (let dz = -radiusCells; dz <= radiusCells; dz++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      const cellX = centerCellX + dx;
      const cellZ = centerCellZ + dz;
      if (cloudRandom(cellX, cellZ, weatherSeed, 0) >= weather.occupancy) continue;
      const xMeters = (
        cellX + 0.12 + cloudRandom(cellX, cellZ, weatherSeed, 1) * 0.76
      ) * CLOUD_CELL_SIZE_METERS;
      const zMeters = (
        cellZ + 0.12 + cloudRandom(cellX, cellZ, weatherSeed, 2) * 0.76
      ) * CLOUD_CELL_SIZE_METERS;
      const widthVariation = average(
        cloudRandom(cellX, cellZ, weatherSeed, 3),
        cloudRandom(cellX, cellZ, weatherSeed, 6),
      );
      const heightVariation = average(
        cloudRandom(cellX, cellZ, weatherSeed, 4),
        cloudRandom(cellX, cellZ, weatherSeed, 7),
      );
      const width = lerp(
        CLOUD_WIDTH_MIN_METERS,
        CLOUD_WIDTH_MAX_METERS,
        widthVariation,
      ) * weather.sizeScale;
      const height = lerp(
        CLOUD_HEIGHT_MIN_METERS,
        CLOUD_HEIGHT_MAX_METERS,
        heightVariation,
      ) * weather.sizeScale;
      placements.push({
        x: xMeters / metersPerUnit,
        y: CLOUD_ALTITUDE_METERS / metersPerUnit,
        z: zMeters / metersPerUnit,
        width: width / metersPerUnit,
        height: height / metersPerUnit,
        variant: Math.floor(
          cloudRandom(cellX, cellZ, weatherSeed, 5) * CLOUD_VARIANT_COUNT,
        ),
        mirrored: cloudRandom(cellX, cellZ, weatherSeed, 8) < 0.5,
      });
    }
  }
  return placements;
}

/** Selects a deliberately non-uniform weather regime from a stable area seed. */
export function cloudWeatherForSeed(seed: number): CloudWeatherProfile {
  const totalWeight = CLOUD_WEATHER_PROFILES.reduce(
    (total, profile) => total + profile.weight,
    0,
  );
  let selection = cloudRandom(0, 0, seed, 97) * totalWeight;
  for (const profile of CLOUD_WEATHER_PROFILES) {
    selection -= profile.weight;
    if (selection < 0) return profile;
  }
  return CLOUD_WEATHER_PROFILES[CLOUD_WEATHER_PROFILES.length - 1];
}

export function cloudRandom(
  x: number,
  z: number,
  seed: number,
  channel: number,
): number {
  let hash = seed | 0;
  hash = Math.imul(hash ^ (x | 0), 0x45d9f3b);
  hash = Math.imul(hash ^ (z | 0), 0x45d9f3b);
  hash = Math.imul(hash ^ channel, 0x45d9f3b);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  return (hash >>> 0) / 4_294_967_296;
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function average(first: number, second: number): number {
  return (first + second) * 0.5;
}
