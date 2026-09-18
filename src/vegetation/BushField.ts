import { Matrix, Scene, Vector3 } from "@babylonjs/core";
import {
  acquireBushImpostorAssets,
  bushRenderedCaptureSize,
  createBushModel,
} from "./BushImpostor";
import { setVegetationWindShear } from "../procedural/ProceduralCaptureMaterial";
import { windShearFraction } from "./Wind";
import { isTerrainFootprintAbove, sampleElevation } from "../world/Geo";
import type { TerrainData } from "../terrain/TerrainData";
import { LandCoverClass } from "../world/WorldCover";
import type { VegetationFieldResult } from "./VegetationField";
import { createRegionalVegetationField } from "./VegetationFieldRenderers";
import { configureVegetationMaterials } from "./VegetationMaterial";
import type { HabitatFieldSpec } from "./HabitatNoise";
import {
  createHabitatPlacement,
  jitteredPlacementRow,
  addProceduralVariantPlacement,
  packInstanceMatrices,
  VegetationPlacementOptions,
} from "./VegetationPlacement";

type BushFieldOptions = VegetationPlacementOptions;

const OCCUPANCY: Readonly<Partial<Record<LandCoverClass, number>>> = {
  [LandCoverClass.TreeCover]: 0.18,
  [LandCoverClass.Shrubland]: 0.72,
  [LandCoverClass.Grassland]: 0.08,
  [LandCoverClass.Cropland]: 0.025,
  [LandCoverClass.Wetland]: 0.16,
  [LandCoverClass.Mangrove]: 0.22,
  [LandCoverClass.MossAndLichen]: 0.12,
};

// Sister shrub models available inside one region. Placement binds the choice
// to the locality, so this is a worldwide palette size rather than a per-tile
// cost: one tile normally builds a single one of them.
const BUSH_SISTER_MODELS = 3;

/**
 * Shrubland aside, most ground carries no shrubs at all, and where it does the
 * amount swings widely over a few hundred metres.
 */
const HABITAT: HabitatFieldSpec = {
  patchMeters: 90,
  abundanceMeters: 2400,
  barrenShare: 0.28,
  richestCoverage: 0.92,
};

/** Land cover this dense is shrubland by definition; it thins but never clears. */
const SHRUBLAND_OCCUPANCY = 0.7;
const SHRUBLAND_FLOOR = 0.35;

/** Places procedurally captured shrubs over suitable WorldCover cells. */
export async function createBushField(
  scene: Scene,
  terrain: TerrainData,
  options: BushFieldOptions,
): Promise<VegetationFieldResult> {
  const {
    meshWidth, meshDepth, metersPerUnit, modelVariantSeed, waterLineMeters,
    landCover, exclusionMask, densityScale, renderMode, yieldControl,
    root, random, columns, rows, cellWidth, cellDepth, matrices,
    renderHeight: bushHeight, variantBuckets, habitat,
  } = createHabitatPlacement(scene, "bushField", options, {
    seed: 0x42555348, spacingMeters: 6, heightMeters: 1.8,
  }, "bushes", HABITAT);
  const maximumHalfWidth = bushRenderedCaptureSize(bushHeight) * 0.71;

  if (landCover) {
    for (let row = 0; row < rows; row++) {
      for (const { x, z, lon, lat } of jitteredPlacementRow(
        row, { columns, cellWidth, cellDepth }, meshWidth, meshDepth, terrain.bounds, random,
      )) {
        const occupancy = OCCUPANCY[landCover.sample(lon, lat)] ?? 0;
        if (occupancy === 0) continue;
        const stand = habitat.sample(lon, lat);
        // Shrubland is shrubland wherever the satellite says so, but how much
        // of it is scrub and how much is open still swings district to
        // district. Everywhere else the layer is genuinely absent more often
        // than it is present.
        const density = occupancy >= SHRUBLAND_OCCUPANCY
          ? SHRUBLAND_FLOOR + stand * (1 - SHRUBLAND_FLOOR)
          : stand;
        if (density <= 0) continue;
        const clusteredOccupancy = Math.min(
          1,
          occupancy * density * 2.15 * Math.max(0, densityScale?.(x, z) ?? 1),
        );
        if (random() > clusteredOccupancy) continue;

        const elevation = sampleElevation(terrain, x, z, meshWidth, meshDepth);
        if (exclusionMask?.intersects(x, z, maximumHalfWidth)) continue;
        if (!isTerrainFootprintAbove(
          terrain,
          x,
          z,
          maximumHalfWidth,
          maximumHalfWidth,
          meshWidth,
          meshDepth,
          waterLineMeters,
        )) continue;

        const vigor = Math.pow(random(), 0.72);
        const heightScale = 0.62 + vigor * 0.84;
        const widthScale = 0.68 + vigor * 0.5;
        const widthScaleX = widthScale * (0.82 + random() * 0.36);
        const widthScaleZ = widthScale * (0.82 + random() * 0.36);
        const yaw = random() * Math.PI * 2;
        const pitch = (random() - 0.5) * 0.05;
        const roll = (random() - 0.5) * 0.05;
        const matrix = Matrix.Compose(
            new Vector3(widthScaleX, heightScale, widthScaleZ),
            new Vector3(pitch, yaw, roll).toQuaternion(),
            new Vector3(x, elevation / metersPerUnit, z),
          );
        matrices.push(matrix);
        addProceduralVariantPlacement(
          variantBuckets,
          "bushes",
          lon,
          lat,
          modelVariantSeed,
          matrix,
          undefined,
          BUSH_SISTER_MODELS,
        );
      }
      await yieldControl?.();
    }
  }

  const matrixData = await packInstanceMatrices(matrices, yieldControl);
  return createRegionalVegetationField(
    scene, root, variantBuckets.values(), matrixData,
    { metersPerUnit, renderMode, yieldControl, snowCover: options.snowCover },
    (bucket, suffix) => ({
      rootName: `bushField-${suffix}`,
      impostorName: `bushImpostors-${suffix}`,
      renderHeight: bushHeight,
      loadAssets: () => acquireBushImpostorAssets(scene, bucket.variant),
      createModel: () => createBushModel(scene, bushHeight, bucket.variant.seed),

      configure: (bush, bushModel) => {
        configureVegetationMaterials([bush], {
          floats: { impostorLodNear: 20, impostorLodFar: 50 },
        });
        setVegetationWindShear([bush, bushModel], windShearFraction("bush"));
      },
    }),
  );
}
