import { Matrix } from "@babylonjs/core";
import type { HorizontalExclusionMask } from "./Geo";
import type { VegetationRenderMode } from "./VegetationField";
import type { LandCoverSampler } from "./WorldCover";

export interface VegetationPlacementOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  seed?: number;
  spacingMeters?: number;
  waterLineMeters?: number;
  landCover?: LandCoverSampler;
  exclusionMask?: HorizontalExclusionMask;
  densityScale?: (worldX: number, worldZ: number) => number;
  renderMode?: VegetationRenderMode;
  /** Optional cooperative yield used while streaming large placement grids. */
  yieldControl?: () => Promise<void>;
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
