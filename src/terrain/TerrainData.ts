import type { TileBounds, WorldTileId } from "../world/WorldGrid";

/** Canonical terrain data populated for an application-owned world tile area. */
export interface TerrainData {
  /** Raw elevation values in meters, row-major (width × height). */
  elevations: Float32Array;
  /** Relief omitted from geometry but retained for terrain normal mapping. */
  shadingRelief?: Float32Array;
  /** Geometry heights before roads, lakes and pads reshape the surface. */
  reliefReferenceElevations?: Float32Array;
  minElevation: number;
  maxElevation: number;
  width: number;
  height: number;
  worldTile: WorldTileId;
  generationSeed: number;
  groundWidthMeters: number;
  groundHeightMeters: number;
  bounds: TileBounds;
  /** Water classification used when carving terrain shoreline depressions. */
  waterMask?: Uint8Array;
  /** Signed distance to the smoothed classified shoreline, positive on land. */
  shoreDistanceMeters?: Float32Array;
}
