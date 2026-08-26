import { Matrix } from "@babylonjs/core";
import type { HorizontalExclusionMask } from "./Geo";
import type { VegetationRenderMode } from "./VegetationField";
import type { LandCoverSampler } from "./WorldCover";
import type { ProceduralRegionFamily, ProceduralVariant } from "./ProceduralRegions";
import { proceduralVariantAtLocation } from "./ProceduralRegions";

export interface VegetationPlacementOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  seed?: number;
  /** World-level seed used for location-bound procedural model variants. */
  modelVariantSeed?: number;
  /** Calendar snapshot used by procedural vegetation generated for this world. */
  seasonalDate?: Date;
  spacingMeters?: number;
  waterLineMeters?: number;
  landCover?: LandCoverSampler;
  exclusionMask?: HorizontalExclusionMask;
  densityScale?: (worldX: number, worldZ: number) => number;
  renderMode?: VegetationRenderMode;
  /** Optional cooperative yield used while streaming large placement grids. */
  yieldControl?: () => Promise<void>;
  /** Startup may capture immediately; streamed atlas work stays frame-budgeted. */
  impostorCaptureMode?: "fast" | "cooperative";
  /** Creates the field hidden so partially built meshes never flash on screen. */
  startDisabled?: boolean;
}

export interface PlacementGrid {
  columns: number;
  rows: number;
  cellWidth: number;
  cellDepth: number;
}

export function createPlacementGrid(
  meshWidth: number,
  meshDepth: number,
  spacingMeters: number,
  metersPerUnit: number,
): PlacementGrid {
  const spacing = spacingMeters / metersPerUnit;
  const columns = Math.max(1, Math.floor(meshWidth / spacing));
  const rows = Math.max(1, Math.floor(meshDepth / spacing));
  return {
    columns,
    rows,
    cellWidth: meshWidth / columns,
    cellDepth: meshDepth / rows,
  };
}

export async function packInstanceMatrices(
  matrices: readonly Matrix[],
  yieldControl?: () => Promise<void>,
): Promise<Float32Array> {
  const packed = new Float32Array(matrices.length * 16);
  for (let index = 0; index < matrices.length; index++) {
    matrices[index].copyToArray(packed, index * 16);
    if ((index & 511) === 511) await yieldControl?.();
  }
  return packed;
}

export interface ProceduralPlacementBucket {
  variant: ProceduralVariant;
  matrices: Matrix[];
  colors: number[];
}

/** Adds one placement to its stable spatial model-variant bucket. */
export function addProceduralVariantPlacement(
  buckets: Map<string, ProceduralPlacementBucket>,
  family: ProceduralRegionFamily,
  longitude: number,
  latitude: number,
  modelVariantSeed: number,
  matrix: Matrix,
  color?: readonly number[],
): void {
  const variant = proceduralVariantAtLocation(
    family,
    longitude,
    latitude,
    modelVariantSeed,
  );
  let bucket = buckets.get(variant.key);
  if (!bucket) {
    bucket = { variant, matrices: [], colors: [] };
    buckets.set(variant.key, bucket);
  }
  bucket.matrices.push(matrix);
  if (color) bucket.colors.push(...color);
}
