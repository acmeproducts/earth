import type { TreeSpecies } from "./procedural/ProceduralTree";
import { lerp } from "./MathUtils";

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
    tints: readonly (readonly [number, number, number])[];
    maturity: number;
  };
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
  "acacia", "eucalyptus", "fir", "mangrove", "palm", "pine", "spruce",
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
  const tintForClimate = (tint: readonly [number, number, number]): [number, number, number] => [
    lerp(1, tint[0], climateStrength),
    lerp(1, tint[1], climateStrength),
    lerp(1, tint[2], climateStrength),
  ];
  return {
    key: `${climateStrength < 1 ? "mild-" : ""}${season}${season === "autumn" ? `-${maturity}` : ""}`,
    season,
    leafCoverage: lerp(1, seasonal.leafCoverage + (season === "autumn" ? (1 - maturity) * 0.1 : 0), climateStrength),
    ...(season === "autumn" ? {
      autumnPalette: {
        maturity,
        tints: [
          tintForClimate([1.05, 1, 0.75]),
          tintForClimate([1.65, 1.12, 0.22]),
          tintForClimate(species === "birch" ? [1.72, 0.94, 0.16] : seasonal.foliageTint),
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
export function autumnLeafTint(season: TreeSeasonAppearance, sample: number): readonly [number, number, number] {
  const palette = season.autumnPalette;
  if (!palette) return season.foliageTint;
  const greenShare = [0.48, 0.18, 0.04][palette.maturity];
  const goldEnd = [0.9, 0.72, 0.38][palette.maturity];
  return palette.tints[sample < greenShare ? 0 : sample < goldEnd ? 1 : 2];
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

