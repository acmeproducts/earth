import type { TreeSpecies } from "../procedural/ProceduralTree";
import { lerp, smoothstep } from "../core/MathUtils";
import { cellRandom, unitFromSeed } from "../core/Random";

export type TreeSeason = "spring" | "summer" | "autumn" | "winter";

export interface TreeSeasonAppearance {
  /** Stable identity used by the procedural model and impostor caches. */
  key: string;
  season: TreeSeason;
  /** Fraction of deciduous leaf cards retained in the generated crown. */
  leafCoverage: number;
  /** Multiplier baked into each retained foliage vertex color. */
  foliageTint: readonly [number, number, number];
  /** Green, gold and mature autumn tints, with a tree-specific balance. */
  autumnPalette?: {
    tints: readonly LeafTint[];
    /** Half-turned stop between the green and gold anchors. */
    yellowGreen: LeafTint;
    maturity: number;
  };
}

/**
 * One baked leaf color: RGB plus the vertex alpha. Alpha one multiplies the
 * leaf texture as usual. Alpha below one tells the foliage shader to take the
 * hue from the vertex color and only brightness detail from the texture, since
 * multiplying a green leaf can never produce a vivid red or yellow.
 */
export type LeafTint = readonly [number, number, number, number];

const AUTUMN_GOLD: readonly [number, number, number] = [0.92, 0.7, 0.2];
const AUTUMN_YELLOW_GREEN: readonly [number, number, number] = [0.8, 0.78, 0.26];
/** What a mild-climate leaf blends back toward when it only half turns. */
const AUTUMN_LEAF_GREEN: readonly [number, number, number] = [0.36, 0.52, 0.16];

function autumnMatureColor(species: TreeSpecies): readonly [number, number, number] {
  switch (species) {
    case "maple": return [0.78, 0.24, 0.1];
    case "beech": return [0.72, 0.42, 0.16];
    case "birch": return [0.88, 0.74, 0.22];
    case "oak": return [0.7, 0.4, 0.14];
    default: return [0.76, 0.34, 0.12];
  }
}

/**
 * Whether seasonal snow cover is appropriate at a location. Tropical places
 * retain year-round ground cover even during their hemisphere's nominal
 * winter, matching the tropical tree treatment below.
 */
export function hasWinterGroundCover(
  date: Date | undefined,
  latitude: number,
): boolean {
  return Boolean(
    date
    && Number.isFinite(date.getTime())
    && Number.isFinite(latitude)
    && Math.abs(latitude) >= 23.5
    && meteorologicalSeason(date.getMonth(), latitude < 0) === "winter",
  );
}

const EVERGREEN_SPECIES = new Set<TreeSpecies>([
  "acacia", "eucalyptus", "fir", "kapok", "mangrove", "palm", "pine", "spruce",
]);

const SUMMER: TreeSeasonAppearance = {
  key: "summer",
  season: "summer",
  leafCoverage: 1,
  foliageTint: [1, 1, 1],
};

/**
 * Resolves the appearance baked into a tree model and its impostor atlas.
 * Seasons reverse across the equator; tropical trees and evergreen species
 * retain their crowns, while subtropical deciduous trees react more gently.
 */
export function treeSeasonAt(
  date: Date | undefined,
  latitude: number,
  species: TreeSpecies,
  autumnVariant = 1,
): TreeSeasonAppearance {
  if (!date || !Number.isFinite(date.getTime())) return SUMMER;

  const season = meteorologicalSeason(date.getMonth(), latitude < 0);
  if (Math.abs(latitude) < 23.5) {
    return { ...SUMMER, key: "tropical", season };
  }
  if (EVERGREEN_SPECIES.has(species)) {
    return evergreenAppearance(season);
  }

  const climateStrength = Math.abs(latitude) < 35 ? 0.55 : 1;
  const seasonal = deciduousAppearance(season, species);
  const maturity = Math.max(0, Math.min(2, Math.floor(autumnVariant)));
  const tintForClimate = (tint: readonly [number, number, number]): LeafTint => [
    lerp(1, tint[0], climateStrength),
    lerp(1, tint[1], climateStrength),
    lerp(1, tint[2], climateStrength),
    1,
  ];
  const recolorForClimate = (color: readonly [number, number, number]): LeafTint => [
    lerp(AUTUMN_LEAF_GREEN[0], color[0], climateStrength),
    lerp(AUTUMN_LEAF_GREEN[1], color[1], climateStrength),
    lerp(AUTUMN_LEAF_GREEN[2], color[2], climateStrength),
    0,
  ];
  return {
    key: `${climateStrength < 1 ? "mild-" : ""}${season}${season === "autumn" ? `-${maturity}` : ""}`,
    season,
    leafCoverage: lerp(1, seasonal.leafCoverage + (season === "autumn" ? (1 - maturity) * 0.1 : 0), climateStrength),
    ...(season === "autumn" ? {
      autumnPalette: {
        maturity,
        yellowGreen: [...recolorForClimate(AUTUMN_YELLOW_GREEN).slice(0, 3) as [number, number, number], 0.5],
        tints: [
          tintForClimate([1.05, 1, 0.75]),
          recolorForClimate(AUTUMN_GOLD),
          recolorForClimate(autumnMatureColor(species)),
        ],
      },
    } : {}),
    foliageTint: [
      lerp(1, seasonal.foliageTint[0], climateStrength),
      lerp(1, seasonal.foliageTint[1], climateStrength),
      lerp(1, seasonal.foliageTint[2], climateStrength),
    ],
  };
}

/** One color per whole leaf card, shared by the model and atlas bake. */
export function autumnLeafTint(season: TreeSeasonAppearance, sample: number): LeafTint {
  const palette = season.autumnPalette;
  if (!palette) return [season.foliageTint[0], season.foliageTint[1], season.foliageTint[2], 1];
  const [green, gold, mature] = palette.tints;
  const greenShare = [0.48, 0.18, 0.04][palette.maturity];
  if (sample <= greenShare) return green;

  // The turn runs green, yellow-green, gold, orange, then the species' mature
  // color, but one tree only occupies a slice of it: a crown is mostly at one
  // stage, and the full range shows across a forest, not on a single tree.
  const [firstStage, lastStage] = [[0.05, 0.5], [0.4, 0.78], [0.66, 1]][palette.maturity];
  const stage = lerp(firstStage, lastStage, (sample - greenShare) / (1 - greenShare));

  // Vertex alpha falls as the leaf turns, so the shader lets the texture's
  // green linger in veins and folds of a half-turned leaf.
  const orange = lerpLeafTint(gold, mature, 0.55);
  const stops: readonly (readonly [number, LeafTint])[] = [
    [0, green],
    [0.3, palette.yellowGreen],
    [0.55, [gold[0], gold[1], gold[2], 0.15]],
    [0.78, orange],
    [1, mature],
  ];
  for (let index = 1; index < stops.length; index++) {
    const [end, to] = stops[index];
    if (stage > end) continue;
    const [start, from] = stops[index - 1];
    return lerpLeafTint(from, to, (stage - start) / (end - start));
  }
  return mature;
}

function lerpLeafTint(from: LeafTint, to: LeafTint, amount: number): LeafTint {
  return [
    lerp(from[0], to[0], amount),
    lerp(from[1], to[1], amount),
    lerp(from[2], to[2], amount),
    lerp(from[3], to[3], amount),
  ];
}

function meteorologicalSeason(month: number, southernHemisphere: boolean): TreeSeason {
  const northern: TreeSeason = month < 2 || month === 11
    ? "winter"
    : month < 5
      ? "spring"
      : month < 8
        ? "summer"
        : "autumn";
  if (!southernHemisphere) return northern;
  return northern === "winter" ? "summer"
    : northern === "summer" ? "winter"
      : northern === "spring" ? "autumn"
        : "spring";
}

function evergreenAppearance(season: TreeSeason): TreeSeasonAppearance {
  if (season !== "winter") return { ...SUMMER, key: `evergreen-${season}`, season };
  return {
    key: "evergreen-winter",
    season,
    leafCoverage: 1,
    foliageTint: [0.9, 0.96, 1.04],
  };
}

function deciduousAppearance(
  season: TreeSeason,
  species: TreeSpecies,
): Omit<TreeSeasonAppearance, "key"> {
  switch (season) {
    case "winter":
      return { season, leafCoverage: 0.035, foliageTint: [0.68, 0.5, 0.28] };
    case "spring":
      return { season, leafCoverage: 0.58, foliageTint: [1.08, 1.18, 0.78] };
    case "autumn": {
      const red = species === "maple" ? 1.48 : species === "beech" ? 1.28 : 1.36;
      const green = species === "oak" ? 0.68 : 0.56;
      return { season, leafCoverage: 0.72, foliageTint: [red, green, 0.2] };
    }
    default:
      return { season, leafCoverage: 1, foliageTint: [1, 1, 1] };
  }
}


/** Center of one leaf card in the tree's source space. */
export interface LeafCardPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * Turn order for every leaf card of one crown, as the unit samples that
 * `autumnLeafTint` maps onto the palette. Leaves do not turn at random: the
 * sun-exposed top and rim of the crown go first, whole branch clusters turn
 * together, and only a little per-leaf scatter softens the edges. The scores
 * are rank-normalized, so the pattern decides *which* leaves turn while the
 * palette's maturity shares still decide *how many*.
 */
export function autumnLeafSamples(cards: readonly LeafCardPosition[], seed: number): number[] {
  const count = cards.length;
  if (count === 0) return [];

  let minY = Infinity;
  let maxY = -Infinity;
  let centerX = 0;
  let centerZ = 0;
  for (const card of cards) {
    minY = Math.min(minY, card.y);
    maxY = Math.max(maxY, card.y);
    centerX += card.x;
    centerZ += card.z;
  }
  centerX /= count;
  centerZ /= count;
  let maxRadius = 0;
  for (const card of cards) {
    maxRadius = Math.max(maxRadius, Math.hypot(card.x - centerX, card.z - centerZ));
  }
  const height = Math.max(maxY - minY, 1e-6);
  const radius = Math.max(maxRadius, 1e-6);
  // A handful of patches across the crown, each about the size of a branch's foliage.
  const patchSize = Math.max(radius, height * 0.5) * 0.45;
  const detailSeed = seed ^ 0x5bd1e995;

  const scores = cards.map((card, index) => {
    const top = (card.y - minY) / height;
    const outward = Math.hypot(card.x - centerX, card.z - centerZ) / radius;
    const patches = valueNoise3(card.x / patchSize, card.y / patchSize, card.z / patchSize, seed) * 0.7
      + valueNoise3(card.x / patchSize * 2.3, card.y / patchSize * 2.3, card.z / patchSize * 2.3, detailSeed) * 0.3;
    const jitter = unitFromSeed(index ^ seed ^ 0x4c454146);
    return 0.26 * top + 0.18 * outward + 0.48 * patches + 0.08 * jitter;
  });

  const order = scores.map((_, index) => index).sort((a, b) => scores[a] - scores[b] || a - b);
  const samples = new Array<number>(count);
  order.forEach((cardIndex, rank) => {
    samples[cardIndex] = rank / count;
  });
  return samples;
}

/** One octave of 3D value noise in [0, 1), smooth across lattice cells. */
function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const cellZ = Math.floor(z);
  const blendX = smoothstep(0, 1, x - cellX);
  const blendY = smoothstep(0, 1, y - cellY);
  const blendZ = smoothstep(0, 1, z - cellZ);
  const corner = (offsetX: number, offsetY: number, offsetZ: number): number =>
    cellRandom(seed, cellX + offsetX, cellY + offsetY, cellZ + offsetZ);
  const lower = lerp(
    lerp(corner(0, 0, 0), corner(1, 0, 0), blendX),
    lerp(corner(0, 1, 0), corner(1, 1, 0), blendX),
    blendY,
  );
  const upper = lerp(
    lerp(corner(0, 0, 1), corner(1, 0, 1), blendX),
    lerp(corner(0, 1, 1), corner(1, 1, 1), blendX),
    blendY,
  );
  return lerp(lower, upper, blendZ);
}
