import {
  DEFAULT_WORLD_SEED,
  WORLD_GRID_LEVEL,
  worldTileCoordinatesAtLocation,
} from "../WorldGrid";

export type ProceduralRegionFamily =
  | "trees"
  | "bushes"
  | "grass"
  | "ferns"
  | "tallPlants"
  | "wheat"
  | "rocks";

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
let cachedConfiguredSpanTiles: number | undefined;
const OFFSET_FRACTIONS: Readonly<Record<ProceduralRegionFamily, readonly [number, number]>> = {
  trees: [0, 0],
  bushes: [0.18, 0.55],
  grass: [0.37, 0.15],
  ferns: [0.74, 0.34],
  tallPlants: [0.88, 0.88],
  wheat: [0.21, 0.79],
  rocks: [0.9, 0.62],
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
      const seed = regionalVariantSeed(worldSeed, family, regionX, regionY);
      const variantIndex = seed >>> 0;
      candidates.push({
        // Region identity prevents distant places from cycling through a small
        // preset palette. The cache remains bounded independently of this key.
        key: `${family}/region/${regionX}/${regionY}/seed/${variantIndex}`,
        seed,
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

/**
 * Sister models inside one region are chosen per locality, not per plant. Each
 * one alive in a tile costs its own impostor atlas capture and its own live
 * mesh, so localities are kept far wider than a terrain tile: a tile normally
 * builds exactly one. A power-of-two span keeps the wrapped columns equal.
 */
const LOCALITY_SPAN_TILES = 32;
const LOCALITY_BLEND_TILES = 1.5;

/**
 * Returns which sister model dominates a locality, stable across tiles because
 * it is bound to the location rather than to a per-tile random stream.
 */
export function proceduralLocalVariantAtLocation(
  family: ProceduralRegionFamily,
  longitude: number,
  latitude: number,
  worldSeed = DEFAULT_WORLD_SEED,
  sisterModels = 1,
): number {
  if (sisterModels <= 1) return 0;
  const position = worldTileCoordinatesAtLocation(latitude, longitude);
  const scale = 2 ** WORLD_GRID_LEVEL;
  const label = `${family}Locality`;
  const xCandidates = axisCandidates(
    wrap(position.x, scale),
    LOCALITY_SPAN_TILES,
    LOCALITY_BLEND_TILES,
    scale / LOCALITY_SPAN_TILES,
    true,
  );
  const yCandidates = axisCandidates(
    Math.max(0, Math.min(scale - 1e-9, position.y)),
    LOCALITY_SPAN_TILES,
    LOCALITY_BLEND_TILES,
    Math.ceil(scale / LOCALITY_SPAN_TILES),
    false,
  );
  const cells: AxisCandidate[] = [];
  for (const x of xCandidates) {
    for (const y of yCandidates) {
      cells.push({
        index: (hashParts(worldSeed, label, x.index, y.index) >>> 0) % sisterModels,
        weight: x.weight * y.weight,
      });
    }
  }
  // Dithering individual placements across the narrow overlap gives a mixed
  // transition instead of one straight line where every shrub changes species.
  const selection = spatialSelection(worldSeed, label, position.x, position.y);
  let accumulated = 0;
  for (const cell of cells) {
    accumulated += cell.weight;
    if (selection < accumulated) return cell.index;
  }
  return cells[cells.length - 1].index;
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
  label: string,
  x: number,
  y: number,
): number {
  const xFixed = Math.floor(x * 65_536) >>> 0;
  const yFixed = Math.floor(y * 65_536) >>> 0;
  return (hashParts(worldSeed, label, xFixed, yFixed) >>> 0) / 4_294_967_296;
}

function regionalVariantSeed(
  worldSeed: number,
  family: ProceduralRegionFamily,
  regionX: number,
  regionY: number,
): number {
  return hashParts(worldSeed, `${family}Region`, regionX, regionY) | 0;
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
