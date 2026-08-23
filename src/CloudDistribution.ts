export const CLOUD_CELL_SIZE_METERS = 8_000;
export const CLOUD_VARIANT_COUNT = 8;

const CLOUD_ALTITUDE_METERS = 7_000;
const CLOUD_WIDTH_MIN_METERS = 9_000;
const CLOUD_WIDTH_MAX_METERS = 15_000;
const CLOUD_ASPECT_RATIO_MIN = 1.65;
const CLOUD_ASPECT_RATIO_MAX = 2.15;

export type CloudWeatherKind = "clear" | "sparse" | "scattered" | "dense";

export interface CloudWeatherProfile {
  readonly kind: CloudWeatherKind;
  readonly occupancy: number;
  readonly sizeScale: number;
}

interface WeightedCloudWeatherProfile extends CloudWeatherProfile {
  readonly weight: number;
}

// Cloud-bearing skies dominate; clear weather remains a distinct but rare outcome.
const CLOUD_WEATHER_PROFILES: readonly WeightedCloudWeatherProfile[] = [
  { kind: "clear", weight: 8, occupancy: 0, sizeScale: 1 },
  { kind: "sparse", weight: 22, occupancy: 0.3, sizeScale: 0.9 },
  { kind: "scattered", weight: 52, occupancy: 0.62, sizeScale: 1 },
  { kind: "dense", weight: 18, occupancy: 0.88, sizeScale: 1.3 },
];

export interface CloudPlacement {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
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
  occupancyOverride?: number,
): CloudPlacement[] {
  const weather = cloudWeatherForSeed(weatherSeed);
  const occupancy = occupancyOverride === undefined
    ? weather.occupancy
    : Math.max(0, Math.min(1, occupancyOverride));
  if (occupancy === 0) return [];
  const radiusCells = Math.ceil(visibleRadiusMeters / CLOUD_CELL_SIZE_METERS) + 1;
  const placements: CloudPlacement[] = [];
  for (let dz = -radiusCells; dz <= radiusCells; dz++) {
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      const cellX = centerCellX + dx;
      const cellZ = centerCellZ + dz;
      if (cloudRandom(cellX, cellZ, weatherSeed, 0) >= occupancy) continue;
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
      const aspectVariation = average(
        cloudRandom(cellX, cellZ, weatherSeed, 4),
        cloudRandom(cellX, cellZ, weatherSeed, 7),
      );
      const width = lerp(
        CLOUD_WIDTH_MIN_METERS,
        CLOUD_WIDTH_MAX_METERS,
        widthVariation,
      ) * weather.sizeScale;
      const aspectRatio = lerp(
        CLOUD_ASPECT_RATIO_MIN,
        CLOUD_ASPECT_RATIO_MAX,
        aspectVariation,
      );
      const height = width / aspectRatio;
      placements.push({
        x: xMeters / metersPerUnit,
        y: CLOUD_ALTITUDE_METERS / metersPerUnit,
        z: zMeters / metersPerUnit,
        width: width / metersPerUnit,
        height: height / metersPerUnit,
        depth: width * lerp(
          0.42,
          0.62,
          cloudRandom(cellX, cellZ, weatherSeed, 9),
        ) / metersPerUnit,
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
