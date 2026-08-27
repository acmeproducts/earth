import { SimplexNoise2D } from "./SimplexNoise";
import {
  DEFAULT_WORLD_SEED,
  layerSeed,
  WORLD_GRID_LEVEL,
  type WorldTileId,
} from "./WorldGrid";

export const PROCEDURAL_ACTOR_FAMILIES = [
  "trees",
  "bushes",
  "grass",
  "ferns",
  "tallPlants",
  "rocks",
] as const;

export type ProceduralActorFamily = typeof PROCEDURAL_ACTOR_FAMILIES[number];

export interface ProceduralActorShare {
  /** Normalized share of this actor family; all shares add up to one. */
  ratio: number;
  /** Density multiplier relative to an evenly mixed tile. */
  densityScale: number;
}

export type ProceduralActorMix = Readonly<Record<ProceduralActorFamily, ProceduralActorShare>>;

/** Broad enough that crossing one tile edge cannot noticeably reshuffle the mix. */
const MIX_NOISE_SPAN_TILES = 32;

/** Creates a stable, spatially smooth actor composition at one tile ID. */
export function proceduralActorMixAtTile(
  tile: WorldTileId,
  worldSeed = DEFAULT_WORLD_SEED,
): ProceduralActorMix {
  const levelScale = 2 ** (WORLD_GRID_LEVEL - tile.level);
  const worldScale = 2 ** WORLD_GRID_LEVEL;
  const x = tile.x * levelScale;
  const y = tile.y * levelScale;
  const weights = PROCEDURAL_ACTOR_FAMILIES.map((family) => {
    const noise = new SimplexNoise2D(layerSeed(worldSeed, `proceduralActorMix/${family}`));
    const value = sampleWrappedX(noise, x, y, worldScale);
    return Math.exp(value * 1.2);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const familyCount = PROCEDURAL_ACTOR_FAMILIES.length;
  const entries = PROCEDURAL_ACTOR_FAMILIES.map((family, index) => {
    const ratio = weights[index] / total;
    return [family, { ratio, densityScale: ratio * familyCount }] as const;
  });
  return Object.fromEntries(entries) as ProceduralActorMix;
}

/** Keeps the simplex field continuous where Web Mercator X wraps. */
function sampleWrappedX(
  noise: SimplexNoise2D,
  x: number,
  y: number,
  worldScale: number,
): number {
  const wrappedX = ((x % worldScale) + worldScale) % worldScale;
  const blend = wrappedX / worldScale;
  const sampleY = y / MIX_NOISE_SPAN_TILES;
  const east = noise.sample(wrappedX / MIX_NOISE_SPAN_TILES, sampleY);
  const west = noise.sample((wrappedX - worldScale) / MIX_NOISE_SPAN_TILES, sampleY);
  return east * (1 - blend) + west * blend;
}
