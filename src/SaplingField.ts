import { Scene } from "@babylonjs/core";
import type { TerrainData } from "./TerrainData";
import { createTreeField, TreeFieldResult } from "./TreeField";
import type { VegetationPlacementOptions } from "./VegetationPlacement";

interface SaplingFieldOptions extends VegetationPlacementOptions {
  /** World-level seed shared with mature trees so species groves agree. */
  speciesSeed?: number;
}

const SAPLING_HEIGHT_METERS = 3.5;
const SAPLING_SPACING_METERS = 4.4;

/**
 * Adds a younger tree layer to detailed tiles while reusing the mature-tree
 * species distribution, procedural geometry, and cached impostor atlases.
 */
export function createSaplingField(
  scene: Scene,
  terrain: TerrainData,
  options: SaplingFieldOptions,
): Promise<TreeFieldResult> {
  return createTreeField(scene, terrain, {
    ...options,
    spacingMeters: options.spacingMeters ?? SAPLING_SPACING_METERS,
    occupancy: 0.4,
    edgeOccupancy: 0.18,
    fullDensityDepthMeters: 24,
    renderHeightMeters: SAPLING_HEIGHT_METERS,
    rootName: "saplingField",
    prototypeNamePrefix: "saplingField",
  });
}
