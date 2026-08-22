import type { TileBounds, WorldTileId } from "./WorldGrid";

/** Canonical terrain data populated for an application-owned world tile area. */
export interface TerrainData {
  /** Raw elevation values in meters, row-major (width × height). */
  elevations: Float32Array;
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
}
