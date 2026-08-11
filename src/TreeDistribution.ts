import type { TreeSpecies } from "./ProceduralTree";

/**
 * A deliberately small set of globally common tree groups. These are visual
 * archetypes rather than a claim about the exact botanical species at a point.
 */
export type WorldTreeSpecies = TreeSpecies;

export type TreeBiome =
  | "tropical-rainforest"
  | "tropical-seasonal"
  | "desert"
  | "mediterranean"
  | "temperate-forest"
  | "boreal-forest"
  | "tundra";

export interface TreeRatio {
  species: WorldTreeSpecies;
  /** Share of trees, conditional on trees being present. All ratios sum to 1. */
  ratio: number;
  /** Procedural renderer species used for this geographic tree group. */
  proceduralArchetype: TreeSpecies;
}

export interface TreeDistribution {
  /** Dominant label for display/debugging; use `biomes` for continuous data. */
  biome: TreeBiome;
  /** Smooth normalized biome influences at this location. */
  biomes: Array<{ biome: TreeBiome; ratio: number }>;
  /** Coarse 0..1 habitat suitability, not actual satellite-observed coverage. */
  treeCoverPotential: number;
  trees: TreeRatio[];
}

type Weights = Partial<Record<WorldTreeSpecies, number>>;
type BiomeWeights = Record<TreeBiome, number>;

const BIOME_ORDER: readonly TreeBiome[] = [
  "tropical-rainforest",
  "tropical-seasonal",
  "desert",
  "mediterranean",
  "temperate-forest",
  "boreal-forest",
  "tundra",
];

const SPECIES_ORDER: readonly WorldTreeSpecies[] = [
  "acacia", "beech", "birch", "eucalyptus", "fir", "mangrove",
  "maple", "oak", "palm", "pine", "spruce",
];

const ARCHETYPE: Readonly<Record<WorldTreeSpecies, TreeSpecies>> = {
  acacia: "acacia",
  beech: "beech",
  birch: "birch",
  eucalyptus: "eucalyptus",
  fir: "fir",
  mangrove: "mangrove",
  maple: "maple",
  oak: "oak",
  palm: "palm",
  pine: "pine",
  spruce: "spruce",
};

const BIOME_TREES: Readonly<Record<TreeBiome, Weights>> = {
  "tropical-rainforest": { palm: 0.28, oak: 0.22, mangrove: 0.08, acacia: 0.12, eucalyptus: 0.1, beech: 0.2 },
  "tropical-seasonal": { acacia: 0.34, palm: 0.2, oak: 0.16, eucalyptus: 0.3 },
  desert: { acacia: 0.58, palm: 0.3, pine: 0.12 },
  mediterranean: { oak: 0.4, pine: 0.38, eucalyptus: 0.12, acacia: 0.1 },
  "temperate-forest": { oak: 0.29, pine: 0.2, maple: 0.16, beech: 0.14, birch: 0.12, fir: 0.09 },
  "boreal-forest": { spruce: 0.36, pine: 0.28, fir: 0.18, birch: 0.18 },
  tundra: {},
};

/**
 * Estimates a broad tree mixture from coordinates alone.
 *
 * This is intentionally a deterministic, offline approximation. Actual tree
 * presence still comes from WorldCover; this function supplies a plausible
 * species mix for procedural generation inside its tree-cover cells.
 */
export function treeDistributionAt(longitude: number, latitude: number): TreeDistribution {
  assertCoordinates(longitude, latitude);
  const lon = wrapLongitude(longitude);
  const biomeWeights = biomeInfluencesAt(lon, latitude);
  const biomes = BIOME_ORDER
    .map((biome) => ({ biome, ratio: biomeWeights[biome] }))
    .filter(({ ratio }) => ratio > 1e-8);
  const biome = biomes.reduce((dominant, candidate) => (
    candidate.ratio > dominant.ratio ? candidate : dominant
  )).biome;
  const weights = blendedTreeWeights(biomeWeights, lon, latitude);
  return {
    biome,
    biomes,
    treeCoverPotential: coverPotential(biomeWeights, lon, latitude),
    trees: normalize(weights),
  };
}

/** Selects a species from a distribution using a caller-owned deterministic random value. */
export function sampleWorldTreeSpecies(
  distribution: TreeDistribution,
  randomValue: number,
): WorldTreeSpecies | undefined {
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new RangeError("randomValue must be in the range [0, 1).");
  }
  let cumulative = 0;
  for (const tree of distribution.trees) {
    cumulative += tree.ratio;
    if (randomValue < cumulative) return tree.species;
  }
  return distribution.trees.at(-1)?.species;
}

function biomeInfluencesAt(lon: number, lat: number): BiomeWeights {
  const absoluteLatitude = Math.abs(lat);
  const weights = emptyBiomeWeights();

  // Latitude supplies a smooth climate baseline through overlapping anchors.
  if (absoluteLatitude <= 10) weights["tropical-rainforest"] = 1;
  else if (absoluteLatitude <= 22) blendPair(weights, "tropical-rainforest", "tropical-seasonal", smoothstep(10, 22, absoluteLatitude));
  else if (absoluteLatitude <= 34) blendPair(weights, "tropical-seasonal", "temperate-forest", smoothstep(22, 34, absoluteLatitude));
  else if (absoluteLatitude <= 50) weights["temperate-forest"] = 1;
  else if (absoluteLatitude <= 64) blendPair(weights, "temperate-forest", "boreal-forest", smoothstep(50, 64, absoluteLatitude));
  else if (absoluteLatitude <= 78) blendPair(weights, "boreal-forest", "tundra", smoothstep(64, 78, absoluteLatitude));
  else weights.tundra = 1;

  const desertInfluence = smoothUnion([
    smoothRectangle(lon, lat, -17, 60, 14, 34, 5, 4),
    smoothRectangle(lon, lat, 116, 146, -34, -17, 5, 4),
    smoothRectangle(lon, lat, 45, 105, 30, 46, 6, 4),
  ]) * 0.94;
  blendToward(weights, "desert", desertInfluence);

  const rainforestInfluence = smoothUnion([
    smoothRectangle(lon, lat, -82, -45, -16, 8, 5, 4),
    smoothRectangle(lon, lat, 9, 32, -9, 8, 4, 3),
    smoothRectangle(lon, lat, 92, 155, -12, 24, 6, 4),
  ]) * 0.82;
  blendToward(weights, "tropical-rainforest", rainforestInfluence);

  const mediterraneanInfluence = smoothUnion([
    smoothRectangle(lon, lat, -12, 42, 30, 46, 5, 4),
    smoothRectangle(lon, lat, -125, -115, 30, 43, 3, 4),
    smoothRectangle(lon, lat, 110, 155, -40, -28, 5, 4),
  ]) * 0.78;
  blendToward(weights, "mediterranean", mediterraneanInfluence);
  return normalizeBiomeWeights(weights);
}

function blendedTreeWeights(biomes: BiomeWeights, lon: number, lat: number): Weights {
  const weights: Weights = {};
  for (const biome of BIOME_ORDER) {
    for (const [species, ratio] of Object.entries(BIOME_TREES[biome])) {
      const typedSpecies = species as WorldTreeSpecies;
      weights[typedSpecies] = (weights[typedSpecies] ?? 0) + (ratio ?? 0) * biomes[biome];
    }
  }

  const australia = smoothRectangle(lon, lat, 110, 155, -44, -10, 5, 4);
  weights.eucalyptus = (weights.eucalyptus ?? 0) + 0.85 * australia;

  const congo = smoothRectangle(lon, lat, 9, 32, -9, 8, 4, 3);
  weights.palm = (weights.palm ?? 0) * (1 - 0.45 * congo);
  weights.acacia = (weights.acacia ?? 0) + 0.12 * congo;

  const continental = smoothUnion([
    smoothBand(lon, 20, 180, 8),
    smoothBand(lon, -180, -50, 8),
  ]);
  weights.spruce = (weights.spruce ?? 0) + 0.12 * biomes["boreal-forest"] * continental;
  weights.pine = (weights.pine ?? 0) + 0.06 * biomes["boreal-forest"] * continental;
  return weights;
}

function coverPotential(biomes: BiomeWeights, lon: number, lat: number): number {
  const base: Readonly<Record<TreeBiome, number>> = {
    "tropical-rainforest": 0.92,
    "tropical-seasonal": 0.58,
    desert: 0.08,
    mediterranean: 0.42,
    "temperate-forest": 0.68,
    "boreal-forest": 0.72,
    tundra: 0,
  };
  const blended = BIOME_ORDER.reduce((sum, biome) => sum + base[biome] * biomes[biome], 0);
  const woodedInfluence = 1 - biomes.tundra;
  const variation = Math.sin((lon + lat * 1.7) * Math.PI / 90) * 0.04 * woodedInfluence;
  return clamp01(blended + variation);
}

function normalize(weights: Weights): TreeRatio[] {
  const entries = SPECIES_ORDER
    .map((species): [WorldTreeSpecies, number] => [species, weights[species] ?? 0])
    .filter(([, weight]) => weight > 1e-10);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total === 0) return [];
  return entries
    .map(([species, weight]) => ({
      species,
      ratio: weight / total,
      proceduralArchetype: ARCHETYPE[species],
    }));
}

function emptyBiomeWeights(): BiomeWeights {
  return {
    "tropical-rainforest": 0,
    "tropical-seasonal": 0,
    desert: 0,
    mediterranean: 0,
    "temperate-forest": 0,
    "boreal-forest": 0,
    tundra: 0,
  };
}

function blendPair(weights: BiomeWeights, from: TreeBiome, to: TreeBiome, amount: number): void {
  weights[from] = 1 - amount;
  weights[to] = amount;
}

function blendToward(weights: BiomeWeights, target: TreeBiome, amount: number): void {
  const clamped = clamp01(amount);
  for (const biome of BIOME_ORDER) weights[biome] *= 1 - clamped;
  weights[target] += clamped;
}

function normalizeBiomeWeights(weights: BiomeWeights): BiomeWeights {
  const total = BIOME_ORDER.reduce((sum, biome) => sum + weights[biome], 0);
  for (const biome of BIOME_ORDER) weights[biome] /= total;
  return weights;
}

function smoothRectangle(
  lon: number,
  lat: number,
  west: number,
  east: number,
  south: number,
  north: number,
  longitudeFeather: number,
  latitudeFeather: number,
): number {
  return smoothBand(lon, west, east, longitudeFeather)
    * smoothBand(lat, south, north, latitudeFeather);
}

function smoothBand(value: number, minimum: number, maximum: number, feather: number): number {
  const entering = smoothstep(minimum - feather, minimum + feather, value);
  const leaving = 1 - smoothstep(maximum - feather, maximum + feather, value);
  return entering * leaving;
}

function smoothUnion(influences: readonly number[]): number {
  return 1 - influences.reduce((outside, influence) => outside * (1 - clamp01(influence)), 1);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function assertCoordinates(longitude: number, latitude: number): void {
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError("longitude must be between -180 and 180 degrees.");
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError("latitude must be between -90 and 90 degrees.");
  }
}

function wrapLongitude(longitude: number): number {
  return longitude === 180 ? -180 : longitude;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
