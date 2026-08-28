import { Color3, Matrix, Scene, ShaderMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "./Geo";
import { habitatField } from "./HabitatNoise";
import type { HabitatFieldSpec } from "./HabitatNoise";
import {
  acquireTallPlantImpostorAssets,
  createTallPlantModel,
  tallPlantRenderedCaptureSize,
} from "./TallPlantImpostor";
import { setVegetationWindShear } from "./ProceduralCaptureMaterial";
import { createSeededRandom } from "./Random";
import type { TerrainData } from "./TerrainData";
import {
  combineVegetationFieldResults,
  createVegetationFieldResult,
} from "./VegetationField";
import type { VegetationFieldResult } from "./VegetationField";
import { createVegetationFieldRenderers } from "./VegetationFieldRenderers";
import { SHADOW_DARKNESS } from "./VegetationShadowReceiver";
import {
  addProceduralVariantPlacement,
  proceduralBucketSuffix,
  createPlacementGrid,
  packInstanceMatrices,
} from "./VegetationPlacement";
import type {
  ProceduralPlacementBucket,
  VegetationPlacementOptions,
} from "./VegetationPlacement";
import { windShearFraction } from "./Wind";
import { LandCoverClass } from "./WorldCover";
import { DEFAULT_WORLD_SEED } from "./WorldGrid";

type TallPlantFieldOptions = VegetationPlacementOptions;

const TALL_PLANT_HEIGHT_METERS = 1.75;
const COLONY_SPACING_METERS = 9.25;
const COLONY_MIN_COUNT = 7;
const COLONY_MAX_COUNT = 14;
const COLONY_RADIUS_METERS = 6.2;
// Sister flower models available inside one region. Placement binds the choice
// to the locality, so neighbouring stands share a species and one tile normally
// builds a single one of them instead of paying for an atlas per variant.
const SPECIES_VARIANTS = 3;

/**
 * Wildflowers are the rarest of the scattered layers and the most uneven: a
 * meadow solid with them, then nothing for a kilometre. The high barren share
 * is what makes finding one worth something.
 */
const HABITAT: HabitatFieldSpec = {
  patchMeters: 120,
  abundanceMeters: 3000,
  barrenShare: 0.45,
  richestCoverage: 0.9,
};
const GROUND_OFFSET_METERS = 0.025;
const OCCUPANCY: Readonly<Partial<Record<LandCoverClass, number>>> = {
  [LandCoverClass.TreeCover]: 0.04,
  [LandCoverClass.Shrubland]: 0.15,
  [LandCoverClass.Grassland]: 0.26,
  [LandCoverClass.Cropland]: 0.03,
  [LandCoverClass.Wetland]: 0.3,
  [LandCoverClass.MossAndLichen]: 0.055,
};

/** Places dense, irregular colonies of tall flowering herbaceous plants. */
export async function createTallPlantField(
  scene: Scene,
  terrain: TerrainData,
  options: TallPlantFieldOptions,
): Promise<VegetationFieldResult> {
  const {
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x54414c4c,
    modelVariantSeed = DEFAULT_WORLD_SEED,
    spacingMeters = COLONY_SPACING_METERS,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    densityScale,
    renderMode = "auto",
    yieldControl,
    startDisabled = false,
  } = options;
  const renderHeight = TALL_PLANT_HEIGHT_METERS / metersPerUnit;
  const root = new TransformNode("tallPlantField", scene);
  if (startDisabled) root.setEnabled(false);
  const random = createSeededRandom(seed);
  const habitat = habitatField("tallPlants", modelVariantSeed, HABITAT);
  const { columns, rows, cellWidth, cellDepth } = createPlacementGrid(
    meshWidth,
    meshDepth,
    spacingMeters,
    metersPerUnit,
  );
  const maximumHalfWidth = tallPlantRenderedCaptureSize(renderHeight) * 0.58;
  const matrices: Matrix[] = [];
  const variantBuckets = new Map<string, ProceduralPlacementBucket>();

  if (landCover) {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const anchorX = -meshWidth / 2 + (column + 0.12 + random() * 0.76) * cellWidth;
        const anchorZ = meshDepth / 2 - (row + 0.12 + random() * 0.76) * cellDepth;
        const anchorLocation = sceneToLonLat(
          anchorX,
          anchorZ,
          terrain.bounds,
          meshWidth,
          meshDepth,
        );
        const coverOccupancy = OCCUPANCY[landCover.sample(
          anchorLocation.lon,
          anchorLocation.lat,
        )] ?? 0;
        if (coverOccupancy === 0) continue;

        const colonyStrength = habitat.sample(anchorLocation.lon, anchorLocation.lat);
        if (colonyStrength <= 0) continue;
        const occupancy = Math.min(1, coverOccupancy * colonyStrength * 3.1
          * Math.max(0, densityScale?.(anchorX, anchorZ) ?? 1));
        if (random() > occupancy) continue;

        const colonyCount = COLONY_MIN_COUNT + Math.floor(
          random() * (COLONY_MAX_COUNT - COLONY_MIN_COUNT + 1),
        );
        const colonyRotation = random() * Math.PI * 2;
        const colonyVigor = 0.82 + random() * 0.34;
        addPlant(anchorX, anchorZ, colonyVigor * (0.94 + random() * 0.12));
        for (let member = 1; member < colonyCount; member++) {
          const angle = colonyRotation + member * 2.399963229728653
            + (random() - 0.5) * 0.62;
          const distance = Math.sqrt((member + random()) / colonyCount)
            * COLONY_RADIUS_METERS / metersPerUnit;
          addPlant(
            anchorX + Math.cos(angle) * distance,
            anchorZ + Math.sin(angle) * distance,
            colonyVigor * (0.7 + random() * 0.58),
          );
        }
      }
      await yieldControl?.();
    }
  }

  const matrixData = await packInstanceMatrices(matrices, yieldControl);
  const fields: VegetationFieldResult[] = [];
  for (const bucket of variantBuckets.values()) {
    const suffix = proceduralBucketSuffix(bucket);
    const { root: variantRoot, impostor: plants, model: plantModel } =
      await createVegetationFieldRenderers(scene, {
        rootName: `tallPlantField-${suffix}`,
        impostorName: `tallPlantImpostors-${suffix}`,
        renderHeight,
        loadAssets: () => acquireTallPlantImpostorAssets(scene, bucket.variant),
        createModel: () => createTallPlantModel(
          scene,
          renderHeight,
          bucket.variant.seed,
          bucket.variant.variantIndex,
        ),
      });
    variantRoot.parent = root;
    configureRenderers(plants, plantModel, meshWidth, meshDepth);
    fields.push(await createVegetationFieldResult(
      variantRoot,
      [plants],
      [plantModel],
      await packInstanceMatrices(bucket.matrices, yieldControl),
      metersPerUnit,
      renderMode,
      undefined,
      yieldControl,
    ));
  }
  return combineVegetationFieldResults(root, fields, matrixData);

  function addPlant(x: number, z: number, vigor: number): void {
    if (exclusionMask?.intersects(x, z, maximumHalfWidth)) return;
    if (!isTerrainFootprintAbove(
      terrain,
      x,
      z,
      maximumHalfWidth,
      maximumHalfWidth,
      meshWidth,
      meshDepth,
      waterLineMeters,
    )) return;
    const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
    if ((OCCUPANCY[landCover!.sample(lon, lat)] ?? 0) === 0) return;
    const elevation = sampleElevation(terrain, x, z, meshWidth, meshDepth);
    const heightScale = Math.max(0.56, vigor * (0.84 + random() * 0.31));
    const widthScale = Math.max(0.58, vigor * (0.72 + random() * 0.48));
    const matrix = Matrix.Compose(
      new Vector3(
        widthScale * (0.82 + random() * 0.36),
        heightScale,
        widthScale * (0.82 + random() * 0.36),
      ),
      new Vector3(
        (random() - 0.5) * 0.055,
        random() * Math.PI * 2,
        (random() - 0.5) * 0.055,
      ).toQuaternion(),
      new Vector3(x, (elevation + GROUND_OFFSET_METERS) / metersPerUnit, z),
    );
    matrices.push(matrix);
    addProceduralVariantPlacement(
      variantBuckets,
      "tallPlants",
      lon,
      lat,
      modelVariantSeed,
      matrix,
      undefined,
      SPECIES_VARIANTS,
    );
  }
}

function configureRenderers(
  plants: import("@babylonjs/core").Mesh,
  plantModel: import("@babylonjs/core").Mesh,
  meshWidth: number,
  meshDepth: number,
): void {
  setVegetationWindShear([plants, plantModel], windShearFraction("grass") * 0.78);
  for (const mesh of [plants, plantModel]) {
    if (!(mesh.material instanceof ShaderMaterial)) continue;
    mesh.material.setFloat("groundColorBlend", 0.08);
    mesh.material.setColor3("distanceGroundColor", new Color3(0.17, 0.31, 0.1));
    mesh.material.setFloat("vegetationShadowAtInstanceRoot", 1);
    mesh.material.setFloat("vegetationShadowDarkness", SHADOW_DARKNESS);
  }
  if (plants.material instanceof ShaderMaterial) {
    plants.material.setFloat("impostorLodNear", 26);
    plants.material.setFloat("impostorLodFar", 58);
    plants.material.setFloat("distanceFadeNear", Math.min(meshWidth, meshDepth) * 0.9);
    plants.material.setFloat("distanceFadeFar", Math.min(meshWidth, meshDepth) * 1.8);
  }
}
