import { SimplexNoise2D } from "./SimplexNoise";
import { LandCoverClass } from "./WorldCover";

/**
 * Ground color variation coarser than the terrain textures can carry.
 *
 * The texture layers repeat every few metres, so they must stay near a uniform
 * average or the repeat becomes visible. That leaves the band above them — the
 * drier rise, the lusher hollow, the worn patch — to the vertex colors, which
 * are anchored to real coordinates and therefore never tile. Land cover alone
 * cannot fill it: its classes are flat fields with hard edges.
 */

const VARIATION_SEED = 0x5eed0a17;

/** Wavelength of each variation band, in metres of ground. */
const BROAD_METERS = 74;
const MID_METERS = 23;
const FINE_METERS = 7.5;

const broadNoise = new SimplexNoise2D(VARIATION_SEED);
const midNoise = new SimplexNoise2D(VARIATION_SEED ^ 0x1d872b);
const fineNoise = new SimplexNoise2D(VARIATION_SEED ^ 0x7c4a19);

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
): [number, number, number] {
  const strength = VARIATION_STRENGTH[landCover] ?? 1;
  if (strength <= 0) return [color[0], color[1], color[2]];

  const { x, y } = groundMeters(longitude, latitude);
  const broad = broadNoise.sample(x / BROAD_METERS, y / BROAD_METERS) *
    bandWeight(BROAD_METERS, minimumFeatureMeters);
  const mid = midNoise.sample(x / MID_METERS, y / MID_METERS) *
    bandWeight(MID_METERS, minimumFeatureMeters);
  const fine = fineNoise.sample(x / FINE_METERS, y / FINE_METERS) *
    bandWeight(FINE_METERS, minimumFeatureMeters);

  // Brightness carries most of the read; the tone shift keeps it from looking
  // like a single color under a dimmer. Weighted towards the broad band because
  // that is the one even coarse terrain meshes can represent reliably.
  const shade = 1 + (broad * 0.07 + mid * 0.032 + fine * 0.022) * strength;
  const tone = broad * 0.72 + mid * 0.28;
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

/**
 * Local metric coordinates. Only differences over a few hundred metres matter
 * here, so a flat approximation around the sample latitude is exact enough and
 * stays continuous across tile boundaries.
 */
function groundMeters(
  longitude: number,
  latitude: number,
): { x: number; y: number } {
  const metersPerDegreeLatitude = 111_320;
  return {
    x: longitude * metersPerDegreeLatitude *
      Math.cos(latitude * Math.PI / 180),
    y: latitude * metersPerDegreeLatitude,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
