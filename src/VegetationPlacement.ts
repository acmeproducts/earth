import { Matrix } from "@babylonjs/core";
import type { HorizontalExclusionMask } from "./Geo";
import type { VegetationRenderMode } from "./VegetationField";
import type { WorldCover } from "./WorldCover";

export interface VegetationPlacementOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  seed?: number;
  spacingMeters?: number;
  waterLineMeters?: number;
  landCover?: WorldCover;
  exclusionMask?: HorizontalExclusionMask;
  ambientOccluders?: readonly Float32Array[];
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

export function packInstanceMatrices(matrices: readonly Matrix[]): Float32Array {
  const packed = new Float32Array(matrices.length * 16);
  matrices.forEach((matrix, index) => matrix.copyToArray(packed, index * 16));
  return packed;
}
