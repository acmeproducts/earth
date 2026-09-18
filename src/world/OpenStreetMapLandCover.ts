import type { VectorTile } from "@mapbox/vector-tile";
import {
  LandCoverClass,
  landCoverSurfaceColor,
  type LandCoverSampler,
} from "./WorldCover";
import { worldTileAtLocation } from "./WorldGrid";

export interface LandCoverMapTile {
  x: number;
  y: number;
  zoom: number;
  data: VectorTile;
}

interface CoverRegion {
  cover: LandCoverClass;
  priority: number;
  area: number;
  bounds: { west: number; east: number; south: number; north: number };
  rings: Array<Array<[longitude: number, latitude: number]>>;
}

class OpenStreetMapLandCover implements LandCoverSampler {
  private readonly regionsByTile: ReadonlyMap<string, readonly CoverRegion[]>;
  private readonly fallback: LandCoverSampler;
  private readonly zoom: number;

  constructor(
    regionsByTile: ReadonlyMap<string, readonly CoverRegion[]>,
    fallback: LandCoverSampler,
    zoom: number,
  ) {
    this.regionsByTile = regionsByTile;
    this.fallback = fallback;
    this.zoom = zoom;
  }

  sample(longitude: number, latitude: number): LandCoverClass {
    let cover = this.fallback.sample(longitude, latitude);
    const tile = worldTileAtLocation(latitude, longitude, this.zoom);
    const regions = this.regionsByTile.get(`${this.zoom}/${tile.x}/${tile.y}`);
    if (!regions) return cover;
    for (const region of regions) {
      if (contains(region, longitude, latitude)) cover = region.cover;
    }
    return cover;
  }

  sampleSurfaceColor(longitude: number, latitude: number): readonly [number, number, number] {
    const cover = this.sample(longitude, latitude);
    if (cover === this.fallback.sample(longitude, latitude)) {
      return this.fallback.sampleSurfaceColor?.(longitude, latitude) ?? landCoverSurfaceColor(cover);
    }
    return landCoverSurfaceColor(cover);
  }
}

// Provider tiles are immutable. Terrain and vegetation repeatedly wrap the same
// tile data; retain decoded polygons only as long as that data remains alive.
const regionCache = new WeakMap<VectorTile, { key: string; regions: CoverRegion[] }>();

/** Overlays precise mapped surface polygons on the global satellite classification. */
export function createOpenStreetMapLandCover(
  tiles: readonly LandCoverMapTile[],
  fallback: LandCoverSampler | undefined,
): LandCoverSampler | undefined {
  if (!fallback) return undefined;
  const zoom = tiles[0]?.zoom;
  if (zoom === undefined) return fallback;
  const regionsByTile = new Map<string, CoverRegion[]>();
  for (const tile of tiles) {
    if (tile.zoom !== zoom) continue;
    const key = `${tile.zoom}/${tile.x}/${tile.y}`;
    let cached = regionCache.get(tile.data);
    if (cached?.key !== key) {
      const regions: CoverRegion[] = [];
      appendLayerRegions(tile, "landuse", 1, regions);
      appendLayerRegions(tile, "landcover", 2, regions);
      // Broad polygons are tested first so smaller, more specific polygons win.
      regions.sort((a, b) => a.priority - b.priority || b.area - a.area);
      cached = { key, regions };
      regionCache.set(tile.data, cached);
    }
    if (cached.regions.length > 0) regionsByTile.set(key, cached.regions);
  }
  return regionsByTile.size === 0
    ? fallback
    : new OpenStreetMapLandCover(regionsByTile, fallback, zoom);
}

function appendLayerRegions(
  tile: LandCoverMapTile,
  layerName: "landcover" | "landuse",
  priority: number,
  target: CoverRegion[],
): void {
  const layer = tile.data.layers[layerName];
  if (!layer) return;
  for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
    const feature = layer.feature(featureIndex);
    const cover = landCoverClassForFeature(layerName, feature.properties);
    if (cover === undefined) continue;
    const geometry = feature.toGeoJSON(tile.x, tile.y, tile.zoom).geometry;
    const polygons = geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
    for (const polygon of polygons) {
      const rings = polygon as CoverRegion["rings"];
      if (rings.length === 0 || rings[0].length < 3) continue;
      const bounds = ringBounds(rings[0]);
      target.push({
        cover,
        priority,
        area: Math.max(0, bounds.east - bounds.west) * Math.max(0, bounds.north - bounds.south),
        bounds,
        rings,
      });
    }
  }
}

export function landCoverClassForFeature(
  layerName: "landcover" | "landuse",
  properties: Readonly<Record<string, unknown>>,
): LandCoverClass | undefined {
  const detail = text(properties.subclass) ?? text(properties.class);
  if (!detail) return undefined;
  if (layerName === "landcover") {
    if (["forest", "wood"].includes(detail)) return LandCoverClass.TreeCover;
    if (["heath", "scrub", "shrubbery"].includes(detail)) return LandCoverClass.Shrubland;
    if (["garden", "grass", "park", "recreation_ground"].includes(detail)) {
      return LandCoverClass.Grassland;
    }
    if (["allotments", "farmland", "farmyard", "orchard", "plant_nursery", "vineyard"].includes(detail)) {
      return LandCoverClass.Cropland;
    }
    if (["bog", "marsh", "swamp", "wetland"].includes(detail)) return LandCoverClass.Wetland;
    if (detail === "dune") return LandCoverClass.Dune;
    if (["beach", "sand"].includes(detail)) return LandCoverClass.Sand;
    if (["bare_rock", "rock", "scree", "shingle"].includes(detail)) {
      return LandCoverClass.Bare;
    }
    if (["glacier", "ice"].includes(detail)) return LandCoverClass.SnowAndIce;
    return undefined;
  }

  if (["bus_station", "commercial", "garages", "industrial", "railway", "retail"].includes(detail)) {
    return LandCoverClass.BuiltUp;
  }
  if (["allotments", "farmland", "farmyard", "orchard", "plant_nursery", "vineyard"].includes(detail)) {
    return LandCoverClass.Cropland;
  }
  if (["cemetery", "pitch", "playground", "stadium", "track"].includes(detail)) {
    return LandCoverClass.Grassland;
  }
  return undefined;
}

function contains(region: CoverRegion, longitude: number, latitude: number): boolean {
  const { bounds, rings } = region;
  if (longitude < bounds.west || longitude > bounds.east || latitude < bounds.south || latitude > bounds.north) {
    return false;
  }
  if (!pointInRing(rings[0], longitude, latitude)) return false;
  return !rings.slice(1).some((ring) => pointInRing(ring, longitude, latitude));
}

function pointInRing(
  ring: ReadonlyArray<readonly [number, number]>,
  longitude: number,
  latitude: number,
): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x, y] = ring[index];
    const [previousX, previousY] = ring[previous];
    const crosses = (y > latitude) !== (previousY > latitude) &&
      longitude < (previousX - x) * (latitude - y) / (previousY - y) + x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function ringBounds(ring: ReadonlyArray<readonly [number, number]>): CoverRegion["bounds"] {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [longitude, latitude] of ring) {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }
  return { west, east, south, north };
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}
