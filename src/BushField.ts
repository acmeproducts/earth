import { Matrix, Scene, ShaderMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import {
  acquireBushImpostorAssets,
  bushRenderedCaptureSize,
  createBushModel,
} from "./BushImpostor";
import { setVegetationWindShear } from "./ProceduralCaptureMaterial";
import { windShearFraction } from "./Wind";
import { isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "./Geo";
import { smoothstep } from "./MathUtils";
import { SimplexNoise2D } from "./SimplexNoise";
import type { TerrainData } from "./TerrainData";
import { LandCoverClass } from "./WorldCover";
import { DEFAULT_WORLD_SEED } from "./WorldGrid";
import {
  combineVegetationFieldResults,
  createVegetationFieldResult,
  VegetationFieldResult,
} from "./VegetationField";
import { createSeededRandom } from "./Random";
import { createVegetationFieldRenderers } from "./VegetationFieldRenderers";
import {
  createPlacementGrid,
  addProceduralVariantPlacement,
  packInstanceMatrices,
  ProceduralPlacementBucket,
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

/** Places procedurally captured shrubs over suitable WorldCover cells. */
export async function createBushField(
  scene: Scene,
  terrain: TerrainData,
  options: BushFieldOptions,
): Promise<VegetationFieldResult> {
  const {
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x42555348,
    modelVariantSeed = DEFAULT_WORLD_SEED,
    spacingMeters = 6,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    densityScale,
    renderMode = "auto",
    yieldControl,
    startDisabled = false,
  } = options;
  const bushHeight = 1.8 / metersPerUnit;
  const root = new TransformNode("bushField", scene);
  if (startDisabled) root.setEnabled(false);
  const random = createSeededRandom(seed);
  const clusterNoise = new SimplexNoise2D(seed ^ 0x9e3779b9);
  const { columns, rows, cellWidth, cellDepth } = createPlacementGrid(
    meshWidth,
    meshDepth,
    spacingMeters,
    metersPerUnit,
  );
  const clusterScale = 26 / metersPerUnit;
  const maximumHalfWidth = bushRenderedCaptureSize(bushHeight) * 0.71;
  const matrices: Matrix[] = [];
  const variantBuckets = new Map<string, ProceduralPlacementBucket>();

  if (landCover) {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = -meshWidth / 2 + (column + 0.08 + random() * 0.84) * cellWidth;
        const z = meshDepth / 2 - (row + 0.08 + random() * 0.84) * cellDepth;
        const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
        const occupancy = OCCUPANCY[landCover.sample(lon, lat)] ?? 0;
        const broadNoise = clusterNoise.sample(x / clusterScale, z / clusterScale) * 0.5 + 0.5;
        const detailNoise = clusterNoise.sample(
          x / (clusterScale * 0.42) + 17.3,
          z / (clusterScale * 0.42) - 29.1,
        ) * 0.5 + 0.5;
        const clusterDensity = smoothstep(0.28, 0.72, broadNoise * 0.82 + detailNoise * 0.18);
        const clusteredOccupancy = Math.min(
          1,
          occupancy * (0.12 + clusterDensity * 1.88) *
            Math.max(0, densityScale?.(x, z) ?? 1),
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
        );
      }
      await yieldControl?.();
    }
  }

  const matrixData = await packInstanceMatrices(matrices, yieldControl);
  const fields: VegetationFieldResult[] = [];
  for (const bucket of variantBuckets.values()) {
    const suffix = `${bucket.variant.regionX}-${bucket.variant.regionY}`;
    const { root: variantRoot, impostor: bush, model: bushModel } =
      await createVegetationFieldRenderers(scene, {
        rootName: `bushField-${suffix}`,
        impostorName: `bushImpostors-${suffix}`,
        renderHeight: bushHeight,
        loadAssets: () => acquireBushImpostorAssets(scene, bucket.variant),
        createModel: () => createBushModel(scene, bushHeight, bucket.variant.seed),
      });
    variantRoot.parent = root;
    if (bush.material instanceof ShaderMaterial) {
      bush.material.setFloat("impostorLodNear", 20);
      bush.material.setFloat("impostorLodFar", 50);
    }
    setVegetationWindShear([bush, bushModel], windShearFraction("bush"));
    fields.push(await createVegetationFieldResult(
      variantRoot,
      [bush],
      [bushModel],
      await packInstanceMatrices(bucket.matrices, yieldControl),
      metersPerUnit,
      renderMode,
      undefined,
      yieldControl,
    ));
  }
  return combineVegetationFieldResults(root, fields, matrixData);
}
