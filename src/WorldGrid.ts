/** The application-owned detailed grid. Provider zooms must not define this value. */
export const WORLD_GRID_LEVEL = 16;
export const DEFAULT_WORLD_SEED = 0x45415254;
export const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;
export const WEB_MERCATOR_WORLD_WIDTH_METERS = 2 * Math.PI * 6_378_137;
export const WORLD_TILE_PROJECTED_SIZE_METERS =
  WEB_MERCATOR_WORLD_WIDTH_METERS / 2 ** WORLD_GRID_LEVEL;

export interface WorldTileId {
  level: number;
  x: number;
  y: number;
}

export interface TileBounds {
  lonWest: number;
  lonEast: number;
  latNorth: number;
  latSouth: number;
}

export interface WorldTileArea {
  /** Tile containing the requested location. */
  center: WorldTileId;
  /** North-west tile in this square area. */
  start: WorldTileId;
  tilesAcross: number;
  bounds: TileBounds;
  /** Stable seed belonging to the center tile, independent of area size. */
  seed: number;
}

/** Returns the canonical application tile containing a geographic position. */
export function worldTileAtLocation(
  latitude: number,
  longitude: number,
  level = WORLD_GRID_LEVEL,
): WorldTileId {
  const scale = 2 ** normalizeLevel(level);
  const latitudeRadians = clampLatitude(latitude) * Math.PI / 180;
  return {
    level: normalizeLevel(level),
    x: wrap(Math.floor(((longitude + 180) / 360) * scale), scale),
    y: Math.max(0, Math.min(
      scale - 1,
      Math.floor((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale),
    )),
  };
}

/** Returns the geographic footprint of one application tile. */
export function worldTileBounds(tile: WorldTileId): TileBounds {
  const level = normalizeLevel(tile.level);
  const scale = 2 ** level;
  const x = wrap(tile.x, scale);
  const y = Math.max(0, Math.min(scale - 1, tile.y));
  return {
    lonWest: x / scale * 360 - 180,
    lonEast: (x + 1) / scale * 360 - 180,
    latNorth: mercatorRowToLatitude(y, scale),
    latSouth: mercatorRowToLatitude(y + 1, scale),
  };
}

/**
 * Selects a square of our tiles around a location. Areas crossing the date line
 * should be streamed as individual tiles; a single lon/lat rectangle cannot
 * represent that wrap without splitting it.
 */
export function worldTileAreaAtLocation(
  latitude: number,
  longitude: number,
  tilesAcross = 1,
  worldSeed = DEFAULT_WORLD_SEED,
  level = WORLD_GRID_LEVEL,
): WorldTileArea {
  const size = Math.max(1, Math.min(4, Math.round(tilesAcross)));
  const center = worldTileAtLocation(latitude, longitude, level);
  const scale = 2 ** center.level;
  const evenSize = size % 2 === 0;
  const longitudeFraction = tileLongitudeFraction(longitude, center);
  const latitudeFraction = tileLatitudeFraction(latitude, center);
  const startX = center.x - Math.floor((size - 1) / 2) -
    (evenSize && longitudeFraction < 0.5 ? 1 : 0);
  const startY = Math.max(0, Math.min(
    scale - size,
    center.y - Math.floor((size - 1) / 2) -
      (evenSize && latitudeFraction < 0.5 ? 1 : 0),
  ));
  const endX = startX + size - 1;
  if (startX < 0 || endX >= scale) {
    throw new Error("Multi-tile areas crossing the antimeridian must be loaded tile-by-tile.");
  }
  const start = { level: center.level, x: startX, y: startY };
  const northWest = worldTileBounds(start);
  const southEast = worldTileBounds({ level: center.level, x: endX, y: startY + size - 1 });
  return {
    center,
    start,
    tilesAcross: size,
    bounds: {
      lonWest: northWest.lonWest,
      lonEast: southEast.lonEast,
      latNorth: northWest.latNorth,
      latSouth: southEast.latSouth,
    },
    seed: worldTileSeed(center, worldSeed),
  };
}

/** Stable identity for a loaded square tile window. */
export function worldTileAreaKey(area: WorldTileArea): string {
  return `${area.start.level}/${area.start.x}/${area.start.y}/${area.tilesAcross}`;
}

/** Stable per-tile seed, independent of load order and online data providers. */
export function worldTileSeed(tile: WorldTileId, worldSeed = DEFAULT_WORLD_SEED): number {
  return deriveSeed(worldSeed, "tile", tile.level, tile.x, tile.y);
}

/** Creates an independent deterministic stream seed for a generation layer. */
export function layerSeed(seed: number, layer: string): number {
  return deriveSeed(seed, layer);
}

function deriveSeed(seed: number, label: string, ...values: number[]): number {
  let hash = (seed ^ 0x811c9dc5) >>> 0;
  for (let index = 0; index < label.length; index++) {
    hash = Math.imul(hash ^ label.charCodeAt(index), 0x01000193) >>> 0;
  }
  for (const value of values) {
    let part = value | 0;
    for (let byte = 0; byte < 4; byte++) {
      hash = Math.imul(hash ^ (part & 0xff), 0x01000193) >>> 0;
      part >>= 8;
    }
  }
  return hash | 0;
}

function normalizeLevel(level: number): number {
  return Math.max(0, Math.min(30, Math.round(level)));
}

function tileLongitudeFraction(longitude: number, tile: WorldTileId): number {
  const bounds = worldTileBounds(tile);
  const normalized = ((longitude + 180) % 360 + 360) % 360 - 180;
  return Math.max(0, Math.min(
    1,
    (normalized - bounds.lonWest) / (bounds.lonEast - bounds.lonWest),
  ));
}

function tileLatitudeFraction(latitude: number, tile: WorldTileId): number {
  const scale = 2 ** tile.level;
  const latitudeRadians = clampLatitude(latitude) * Math.PI / 180;
  const projectedRow = (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale;
  return Math.max(0, Math.min(1, projectedRow - tile.y));
}

function clampLatitude(latitude: number): number {
  return Math.max(-WEB_MERCATOR_MAX_LATITUDE, Math.min(WEB_MERCATOR_MAX_LATITUDE, latitude));
}

function mercatorRowToLatitude(row: number, scale: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * row / scale))) * 180 / Math.PI;
}

function wrap(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
