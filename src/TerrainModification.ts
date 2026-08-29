/** A bounded request for the terrain raster to adapt to a constructed feature. */
export interface TerrainModification {
  readonly minimumX: number;
  readonly maximumX: number;
  readonly minimumZ: number;
  readonly maximumZ: number;
  /** Desired elevation at a point on the feature (in metres). */
  readonly targetElevationAt: (x: number, z: number) => number;
  /** Blend weight, from 0 (leave terrain untouched) to 1 (fully adapt). */
  readonly influenceAt: (x: number, z: number) => number;
}
