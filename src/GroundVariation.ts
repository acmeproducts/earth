import { groundMetersAt } from "./Geo";
import { SimplexNoise2D } from "./SimplexNoise";
import { LandCoverClass } from "./WorldCover";
import { clamp01 } from "./MathUtils";
import { DEFAULT_WORLD_SEED, layerSeed } from "./WorldGrid";

/**
 * Ground color variation coarser than the terrain textures can carry.
 *
 * The texture layers repeat every few metres, so they must stay near a uniform
 * average or the repeat becomes visible. That leaves the band above them — the
 * drier rise, the lusher hollow, the worn patch — to the vertex colors, which
 * are anchored to real coordinates and therefore never tile. Land cover alone
 * cannot fill it: its classes are flat fields with hard edges.
 */

/** Wavelength of each variation band, in metres of ground. */
const BANDS = [
  { meters: 74, shade: 0.07, tone: 0.72 },
  { meters: 23, shade: 0.032, tone: 0.28 },
  { meters: 7.5, shade: 0.022, tone: 0 },
] as const;

/**
 * Built once per world rather than held in a module constant, so re-rolling the
 * world seed re-rolls the ground with everything else. Keyed like the habitat
 * fields: a rise being the dry one is a property of the place, not of whichever
 * tile is streaming it.
 */
const fields = new Map<number, readonly SimplexNoise2D[]>();

function bandNoise(worldSeed: number): readonly SimplexNoise2D[] {
  let noise = fields.get(worldSeed);
  if (!noise) {
    noise = BANDS.map((band) => new SimplexNoise2D(
      layerSeed(worldSeed, `groundVariation/${band.meters}`),
    ));
    fields.set(worldSeed, noise);
  }
  return noise;
}

/**
 * How much of the variation each surface accepts. Engineered and frozen
 * surfaces vary far less than soil and vegetation, and terrain hidden under the
 * water surface should not vary at all.
 */
const VARIATION_STRENGTH: Readonly<Record<number, number>> = {
  [LandCoverClass.Water]: 0,
  [LandCoverClass.SnowAndIce]: 0.22,
  [LandCoverClass.BuiltUp]: 0.45,
};

/**
 * Applies world-anchored color variation to a land-cover surface color.
 *
 * @param color - Base surface color for the land-cover class.
 * @param longitude - Sample longitude in degrees.
 * @param latitude - Sample latitude in degrees.
 * @param landCover - Class the base color came from.
 * @param minimumFeatureMeters - Spacing of the vertices being colored. Bands
 * finer than the mesh can represent are faded out instead of aliasing into
 * per-vertex noise.
 */
export function varyGroundColor(
  color: readonly [number, number, number],
  longitude: number,
  latitude: number,
  landCover: LandCoverClass,
  minimumFeatureMeters = 0,
  worldSeed = DEFAULT_WORLD_SEED,
): [number, number, number] {
  const strength = VARIATION_STRENGTH[landCover] ?? 1;
  if (strength <= 0) return [color[0], color[1], color[2]];

  const { x, y } = groundMetersAt(longitude, latitude);
  const noise = bandNoise(worldSeed);
  // Brightness carries most of the read; the tone shift keeps it from looking
  // like a single color under a dimmer. Both are weighted towards the broad
  // band because that is the one even coarse terrain meshes can represent.
  let shade = 0;
  let tone = 0;
  for (let index = 0; index < BANDS.length; index++) {
    const band = BANDS[index];
    const value = noise[index].sample(x / band.meters, y / band.meters) *
      bandWeight(band.meters, minimumFeatureMeters);
    shade += value * band.shade;
    tone += value * band.tone;
  }
  shade = 1 + shade * strength;
  const dry = Math.max(0, tone) * strength;
  const lush = Math.max(0, -tone) * strength;

  return [
    clamp01(color[0] * (1 + 0.1 * dry - 0.1 * lush) * shade),
    clamp01(color[1] * (1 + 0.04 * dry + 0.05 * lush) * shade),
    clamp01(color[2] * (1 - 0.16 * dry - 0.06 * lush) * shade),
  ];
}

/**
 * Fades a band out as it approaches the resolution of the mesh sampling it. A
 * band shorter than about twice the vertex spacing cannot be reconstructed and
 * would only add per-vertex speckle.
 */
function bandWeight(bandMeters: number, minimumFeatureMeters: number): number {
  if (minimumFeatureMeters <= 0) return 1;
  const t = clamp01((bandMeters / minimumFeatureMeters - 2) / 2);
  return t * t * (3 - 2 * t);
}
