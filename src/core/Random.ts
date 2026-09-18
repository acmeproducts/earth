/**
 * The project's deterministic randomness primitives.
 *
 * Everything generated procedurally traces back to one of these four. Keeping
 * them in one file is what makes a world reproducible: a second mixer with a
 * different divisor or a different avalanche silently forks the output of
 * whichever layer happens to call it, and the divergence only ever shows up as
 * a visual difference nobody can attribute.
 *
 * Prefer `cellRandom` over `createSeededRandom` for anything addressed by
 * position. A sequential stream makes a placement's appearance depend on how
 * many candidates were rejected before it, so it cannot be regenerated for a
 * sub-region and any tweak upstream reshuffles everything after it.
 */

const UNIT_SCALE = 4_294_967_296;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Returns a compact deterministic PRNG with values in [0, 1). */
export function createSeededRandom(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / UNIT_SCALE;
  };
}

/** Maps one integer seed to a unit value in [0, 1). */
export function unitFromSeed(seed: number): number {
  let hash = seed | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  return ((hash ^ (hash >>> 16)) >>> 0) / UNIT_SCALE;
}

/**
 * Unit value in [0, 1) addressed by integer position rather than by draw
 * order. Channels are independent, so one cell can draw as many uncorrelated
 * values as it needs without the order of the draws mattering.
 */
export function cellRandom(seed: number, x: number, y: number, channel = 0): number {
  let hash = seed | 0;
  hash = Math.imul(hash ^ (x | 0), 0x45d9f3b);
  hash = Math.imul(hash ^ (y | 0), 0x45d9f3b);
  hash = Math.imul(hash ^ channel, 0x45d9f3b);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  return (hash >>> 0) / UNIT_SCALE;
}

/**
 * Creates an independent stream seed from a parent seed, a label, and any
 * number of integer coordinates. The label is what keeps sibling layers of one
 * world from sharing a sequence.
 */
export function deriveSeed(seed: number, label: string, ...values: number[]): number {
  let hash = (seed ^ FNV_OFFSET) >>> 0;
  for (let index = 0; index < label.length; index++) {
    hash = Math.imul(hash ^ label.charCodeAt(index), FNV_PRIME) >>> 0;
  }
  for (const value of values) {
    let part = value | 0;
    for (let byte = 0; byte < 4; byte++) {
      hash = Math.imul(hash ^ (part & 0xff), FNV_PRIME) >>> 0;
      part >>= 8;
    }
  }
  return hash | 0;
}

/** Folds a string into a seed. */
export function hashString(value: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), FNV_PRIME);
  }
  return hash | 0;
}

export function spatialHash3(a: number, b: number, c: number): number {
  const value = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return value - Math.floor(value);
}
