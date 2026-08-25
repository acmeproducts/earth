import {
  DEFAULT_WORLD_SEED,
  WORLD_GRID_LEVEL,
  worldTileCoordinatesAtLocation,
} from "./WorldGrid";

export type ProceduralRegionFamily = "trees" | "bushes" | "grass" | "flowers" | "ferns";

export interface ProceduralVariant {
  key: string;
  seed: number;
  family: ProceduralRegionFamily;
  variantIndex: number;
  regionX: number;
  regionY: number;
}

export interface ProceduralRegionCandidate extends ProceduralVariant {
  weight: number;
}

export interface ProceduralRegionSpec {
  spanTiles: number;
  blendTiles: number;
  offsetX: number;
  offsetY: number;
}

const DEFAULT_SPAN_TILES = 256;
/** A small reusable bank prevents unbounded runtime atlas generation during travel. */
export const PROCEDURAL_VARIANTS_PER_FAMILY = 4;
export const FERN_PROCEDURAL_VARIANT_COUNT = 2;
const VARIANT_COUNTS: Readonly<Record<ProceduralRegionFamily, number>> = {
  trees: PROCEDURAL_VARIANTS_PER_FAMILY,
  bushes: PROCEDURAL_VARIANTS_PER_FAMILY,
  grass: PROCEDURAL_VARIANTS_PER_FAMILY,
  flowers: PROCEDURAL_VARIANTS_PER_FAMILY,
  ferns: FERN_PROCEDURAL_VARIANT_COUNT,
};
let cachedConfiguredSpanTiles: number | undefined;
const OFFSET_FRACTIONS: Readonly<Record<ProceduralRegionFamily, readonly [number, number]>> = {
  trees: [0, 0],
  bushes: [0.18, 0.55],
  grass: [0.37, 0.15],
  flowers: [0.55, 0.74],
  ferns: [0.74, 0.34],
};

/** Returns the staggered virtual grid used by one procedural model family. */
export function proceduralRegionSpec(
  family: ProceduralRegionFamily,
  spanTiles = configuredSpanTiles(),
): ProceduralRegionSpec {
  const normalizedSpan = normalizeSpan(spanTiles);
  const [offsetX, offsetY] = OFFSET_FRACTIONS[family];
  return {
    spanTiles: normalizedSpan,
    // Four tiles per side is a broad geographic transition, but still leaves
    // clear separation between the deliberately staggered family boundaries.
    blendTiles: Math.max(0.5, Math.min(4, normalizedSpan * 0.04)),
    offsetX: Math.round(normalizedSpan * offsetX),
    offsetY: Math.round(normalizedSpan * offsetY),
  };
}

/** Returns the one to four regional variants contributing at a location. */
export function proceduralRegionCandidatesAtLocation(
  family: ProceduralRegionFamily,
  longitude: number,
  latitude: number,
  worldSeed = DEFAULT_WORLD_SEED,
  spanTiles = configuredSpanTiles(),
): ProceduralRegionCandidate[] {
  const position = worldTileCoordinatesAtLocation(latitude, longitude);
  return proceduralRegionCandidatesAtCoordinates(
    family,
    position.x,
    position.y,
    worldSeed,
    spanTiles,
  );
}

function proceduralRegionCandidatesAtCoordinates(
  family: ProceduralRegionFamily,
  worldX: number,
  worldY: number,
  worldSeed: number,
  spanTiles: number,
): ProceduralRegionCandidate[] {
  const spec = proceduralRegionSpec(family, spanTiles);
  const scale = 2 ** WORLD_GRID_LEVEL;
  const columns = scale / spec.spanTiles;
  const xCandidates = axisCandidates(
    wrap(worldX + spec.offsetX, scale),
    spec.spanTiles,
    spec.blendTiles,
    columns,
    true,
  );
  const yCandidates = axisCandidates(
    Math.max(0, Math.min(scale - 1e-9, worldY + spec.offsetY)),
    spec.spanTiles,
    spec.blendTiles,
    Math.ceil(scale / spec.spanTiles),
    false,
  );
  const candidates: ProceduralRegionCandidate[] = [];
  for (const x of xCandidates) {
    for (const y of yCandidates) {
      const regionX = x.index;
      const regionY = y.index;
      const variantIndex = regionalVariantIndex(worldSeed, family, regionX, regionY);
      candidates.push({
        key: `${family}/variant/${variantIndex}`,
        seed: variantSeed(worldSeed, family, variantIndex),
        family,
        variantIndex,
        regionX,
        regionY,
        weight: x.weight * y.weight,
      });
    }
  }
  return candidates;
}

/** Selects a stable local model without rendering two variants per placement. */
export function proceduralVariantAtLocation(
  family: ProceduralRegionFamily,
  longitude: number,
  latitude: number,
  worldSeed = DEFAULT_WORLD_SEED,
  spanTiles = configuredSpanTiles(),
): ProceduralVariant {
  const position = worldTileCoordinatesAtLocation(latitude, longitude);
  const candidates = proceduralRegionCandidatesAtCoordinates(
    family,
    position.x,
    position.y,
    worldSeed,
    spanTiles,
  );
  const selection = spatialSelection(worldSeed, family, position.x, position.y);
  let accumulated = 0;
  for (const candidate of candidates) {
    accumulated += candidate.weight;
    if (selection < accumulated) return candidate;
  }
  return candidates[candidates.length - 1];
}

interface AxisCandidate {
  index: number;
  weight: number;
}

function axisCandidates(
  coordinate: number,
  span: number,
  blend: number,
  count: number,
  wraps: boolean,
): AxisCandidate[] {
  const cell = Math.floor(coordinate / span);
  const local = coordinate - cell * span;
  if (local < blend && (wraps || cell > 0)) {
    const rightWeight = smoothstep((local + blend) / (blend * 2));
    return [
      { index: normalizeIndex(cell - 1, count, wraps), weight: 1 - rightWeight },
      { index: normalizeIndex(cell, count, wraps), weight: rightWeight },
    ];
  }
  if (local > span - blend && (wraps || cell + 1 < count)) {
    const rightWeight = smoothstep((local - (span - blend)) / (blend * 2));
    return [
      { index: normalizeIndex(cell, count, wraps), weight: 1 - rightWeight },
      { index: normalizeIndex(cell + 1, count, wraps), weight: rightWeight },
    ];
  }
  return [{ index: normalizeIndex(cell, count, wraps), weight: 1 }];
}

function configuredSpanTiles(): number {
  if (cachedConfiguredSpanTiles !== undefined) return cachedConfiguredSpanTiles;
  if (typeof window === "undefined") {
    cachedConfiguredSpanTiles = DEFAULT_SPAN_TILES;
    return cachedConfiguredSpanTiles;
  }
  const requested = Number(new URLSearchParams(window.location.search).get("procedural-region-size"));
  cachedConfiguredSpanTiles = Number.isFinite(requested) ? requested : DEFAULT_SPAN_TILES;
  return cachedConfiguredSpanTiles;
}

function normalizeSpan(span: number): number {
  const scale = 2 ** WORLD_GRID_LEVEL;
  const rounded = Math.max(4, Math.min(scale, Math.round(span)));
  // Equal wrapped columns avoid a special partial region at the antimeridian.
  let powerOfTwo = 1;
  while (powerOfTwo < rounded) powerOfTwo *= 2;
  const lower = powerOfTwo / 2;
  return lower >= 4 && rounded - lower < powerOfTwo - rounded ? lower : powerOfTwo;
}

function normalizeIndex(index: number, count: number, wraps: boolean): number {
  return wraps ? wrap(index, count) : Math.max(0, Math.min(count - 1, index));
}

function smoothstep(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function spatialSelection(
  worldSeed: number,
  family: ProceduralRegionFamily,
  x: number,
  y: number,
): number {
  const xFixed = Math.floor(x * 65_536) >>> 0;
  const yFixed = Math.floor(y * 65_536) >>> 0;
  return (hashParts(worldSeed, family, xFixed, yFixed) >>> 0) / 4_294_967_296;
}

function regionalVariantIndex(
  worldSeed: number,
  family: ProceduralRegionFamily,
  regionX: number,
  regionY: number,
): number {
  const offset = hashParts(worldSeed, `${family}Palette`) >>> 0;
  const variantCount = VARIANT_COUNTS[family];
  const rowStride = Math.max(1, Math.floor(variantCount / 2));
  return wrap(regionX + regionY * rowStride + offset, variantCount);
}

function variantSeed(
  worldSeed: number,
  family: ProceduralRegionFamily,
  variantIndex: number,
): number {
  return hashParts(worldSeed, `${family}Variant`, variantIndex) | 0;
}

function hashParts(seed: number, label: string, ...values: number[]): number {
  let hash = (seed ^ 0x811c9dc5) >>> 0;
  for (let index = 0; index < label.length; index++) {
    hash = Math.imul(hash ^ label.charCodeAt(index), 0x01000193) >>> 0;
  }
  for (const value of values) {
    let part = value >>> 0;
    for (let byte = 0; byte < 4; byte++) {
      hash = Math.imul(hash ^ (part & 0xff), 0x01000193) >>> 0;
      part >>>= 8;
    }
  }
  return hash;
}

function wrap(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
