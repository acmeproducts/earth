import { groundMetersAt } from "./Geo";
import { clamp, clamp01, smoothstep } from "./MathUtils";
import { SimplexNoise2D } from "./SimplexNoise";
import { layerSeed } from "./WorldGrid";

/**
 * Where a scattered layer is abundant, where it is rare, and where it is gone.
 *
 * Thresholding a single noise field gives every district the same coverage:
 * the patches move around but their density never changes, so the whole world
 * ends up equally sparse. Real ground is not like that — a slope solid with
 * gorse, then kilometres of clean pasture. Three fields supply the difference.
 * An abundance field decides how much of a district the layer claims at all,
 * including districts that carry none of it; a grain field decides whether it
 * arrives as a few large stands or a fine scatter; and the patch field places
 * the stands.
 *
 * All three are anchored to ground metres rather than tile-local scene space,
 * so a stand crosses a tile boundary intact and the pattern never restarts
 * once per tile.
 */

export interface HabitatFieldSpec {
  /** Wavelength of an individual patch at the coarsest grain, in metres. */
  patchMeters: number;
  /** Wavelength of the "how common is this here" field, in metres. */
  abundanceMeters: number;
  /**
   * Share of districts that carry none of the layer at all. Without a real
   * floor the leanest setting still sprinkles a few everywhere, which is the
   * uniform rarity this field exists to avoid.
   */
  barrenShare: number;
  /** Share of the ground the layer claims where it is at its most abundant. */
  richestCoverage: number;
}

export interface HabitatField {
  /**
   * Zero where the layer is absent, rising to one at the heart of a stand.
   * Multiply a density by this rather than testing it, so stands thin out at
   * their margins instead of ending on a contour line.
   */
  sample(longitude: number, latitude: number): number;
}

/**
 * Simplex output clusters around its midpoint, so a raw threshold selects a
 * very different share of the ground than it looks like it does — a threshold
 * of 0.85 keeps 4% of it, not 15%. These are measured 5% quantiles, stable to
 * within 0.008 across seeds and sampling scales, used to flatten the field to
 * a uniform 0..1 so the coverage settings above mean what they say.
 */
const QUANTILES: readonly number[] = [
  0, 0.161, 0.206, 0.243, 0.278, 0.314, 0.352, 0.39, 0.426, 0.462, 0.5,
  0.539, 0.575, 0.611, 0.648, 0.686, 0.722, 0.757, 0.793, 0.838, 1,
];

/**
 * How wide a band of the patch field a stand fades out over. Sparse districts
 * would otherwise get a margin near zero and end on a razor edge, which is the
 * hard boundary the fade exists to avoid.
 */
const MINIMUM_MARGIN = 0.06;
const MAXIMUM_MARGIN = 0.22;

/**
 * Grain runs from one pure scale to the other over a narrow band, so most
 * districts sample a single patch field and the coverage calibration holds.
 */
const GRAIN_EDGE = 0.12;

const fields = new Map<string, HabitatField>();

/**
 * Returns the habitat field for one layer of one world, building it once.
 * Keyed by world seed rather than by tile seed: a district's abundance is a
 * property of the place, not of whichever tile happens to be streaming.
 */
export function habitatField(
  layer: string,
  worldSeed: number,
  spec: HabitatFieldSpec,
): HabitatField {
  const key = `${layer}/${worldSeed}`;
  let field = fields.get(key);
  if (!field) {
    field = createHabitatField(layer, worldSeed, spec);
    fields.set(key, field);
  }
  return field;
}

function createHabitatField(
  layer: string,
  worldSeed: number,
  spec: HabitatFieldSpec,
): HabitatField {
  const seed = layerSeed(worldSeed, `habitat/${layer}`);
  const coarseNoise = new SimplexNoise2D(seed);
  const fineNoise = new SimplexNoise2D(seed ^ 0x5bf03635);
  const abundanceNoise = new SimplexNoise2D(seed ^ 0x27d4eb2f);
  const grainNoise = new SimplexNoise2D(seed ^ 0x165667b1);
  const fineMeters = spec.patchMeters * 0.34;
  const grainMeters = spec.abundanceMeters * 0.63;
  const barren = clamp01(spec.barrenShare);
  const richest = clamp01(spec.richestCoverage);

  return {
    sample(longitude: number, latitude: number): number {
      const { x, y } = groundMetersAt(longitude, latitude);
      const abundance = smoothstep(
        barren,
        1,
        uniform(abundanceNoise, x / spec.abundanceMeters, y / spec.abundanceMeters),
      );
      const coverage = richest * abundance;
      if (coverage <= 0) return 0;

      const grain = smoothstep(
        0.5 - GRAIN_EDGE,
        0.5 + GRAIN_EDGE,
        uniform(grainNoise, x / grainMeters + 91.3, y / grainMeters - 57.8),
      );
      const coarse = uniform(coarseNoise, x / spec.patchMeters, y / spec.patchMeters);
      const fine = uniform(fineNoise, x / fineMeters + 13.7, y / fineMeters + 44.1);
      const patch = coarse + (fine - coarse) * grain;

      const threshold = 1 - coverage;
      const margin = clamp(coverage * 0.8, MINIMUM_MARGIN, MAXIMUM_MARGIN);
      return smoothstep(threshold, threshold + margin, patch);
    },
  };
}

/** Samples one noise field and flattens it to a uniform 0..1. */
function uniform(noise: SimplexNoise2D, x: number, y: number): number {
  const value = clamp01(noise.sample(x, y) * 0.5 + 0.5);
  const steps = QUANTILES.length - 1;
  // The table is monotonic and short; a scan beats the branch-heavy bisection
  // at this size, and this runs once per placement cell.
  for (let step = 0; step < steps; step++) {
    const high = QUANTILES[step + 1];
    if (value > high) continue;
    const low = QUANTILES[step];
    const span = high - low;
    const within = span > 0 ? (value - low) / span : 0;
    return (step + within) / steps;
  }
  return 1;
}
