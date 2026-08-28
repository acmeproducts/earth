import { Color3, Matrix, Scene, ShaderMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "./Geo";
import { smoothstep } from "./MathUtils";
import {
  acquireFernImpostorAssets,
  createFernModel,
  fernRenderedCaptureSize,
} from "./FernImpostor";
import { setVegetationWindShear } from "./ProceduralCaptureMaterial";
import { createSeededRandom } from "./Random";
import { SimplexNoise2D } from "./SimplexNoise";
import type { TerrainData } from "./TerrainData";
import {
  combineVegetationFieldResults,
  createVegetationFieldResult,
  VegetationFieldResult,
} from "./VegetationField";
import { createVegetationFieldRenderers } from "./VegetationFieldRenderers";
import { SHADOW_DARKNESS } from "./VegetationShadowReceiver";
import {
  addProceduralVariantPlacement,
  createPlacementGrid,
  packInstanceMatrices,
  ProceduralPlacementBucket,
  VegetationPlacementOptions,
} from "./VegetationPlacement";
import { windShearFraction } from "./Wind";
import { LandCoverClass } from "./WorldCover";
import { DEFAULT_WORLD_SEED } from "./WorldGrid";

type FernFieldOptions = VegetationPlacementOptions;

const FERN_HEIGHT_METERS = 1.05;
const FERN_SPACING_METERS = 3.8;
const FERN_GROUND_OFFSET_METERS = 0.035;
const FERN_CLUSTER_MIN_COUNT = 3;
const FERN_CLUSTER_MAX_COUNT = 5;
const FERN_CLUSTER_RADIUS_METERS = 1.8;
const OCCUPANCY: Readonly<Partial<Record<LandCoverClass, number>>> = {
  [LandCoverClass.TreeCover]: 0.24,
  [LandCoverClass.Shrubland]: 0.035,
  [LandCoverClass.Wetland]: 0.055,
  [LandCoverClass.Mangrove]: 0.15,
};

/** Places rare fern patches, predominantly beneath trees on detailed terrain. */
export async function createFernField(
  scene: Scene,
  terrain: TerrainData,
  options: FernFieldOptions,
): Promise<VegetationFieldResult> {
  const {
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x4645524e,
    modelVariantSeed = DEFAULT_WORLD_SEED,
    spacingMeters = FERN_SPACING_METERS,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    densityScale,
    renderMode = "auto",
    yieldControl,
    startDisabled = false,
  } = options;
  const renderHeight = FERN_HEIGHT_METERS / metersPerUnit;
  const root = new TransformNode("fernField", scene);
  if (startDisabled) root.setEnabled(false);

  const random = createSeededRandom(seed);
  const clusterNoise = new SimplexNoise2D(seed ^ 0x9e3779b9);
  const detailNoise = new SimplexNoise2D(seed ^ 0x243f6a88);
  const { columns, rows, cellWidth, cellDepth } = createPlacementGrid(
    meshWidth,
    meshDepth,
    spacingMeters,
    metersPerUnit,
  );
  const clusterScale = 22 / metersPerUnit;
  const maximumHalfWidth = fernRenderedCaptureSize(renderHeight) * 0.62;
  const matrices: Matrix[] = [];
  const variantBuckets = new Map<string, ProceduralPlacementBucket>();

  if (landCover) {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = -meshWidth / 2 + (column + 0.14 + random() * 0.72) * cellWidth;
        const z = meshDepth / 2 - (row + 0.14 + random() * 0.72) * cellDepth;
        const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
        const coverOccupancy = OCCUPANCY[landCover.sample(lon, lat)] ?? 0;
        if (coverOccupancy === 0) continue;
        const broad = clusterNoise.sample(x / clusterScale, z / clusterScale) * 0.5 + 0.5;
        const detail = detailNoise.sample(
          x / (clusterScale * 0.38) + 21.7,
          z / (clusterScale * 0.38) - 13.9,
        ) * 0.5 + 0.5;
        const clusterDensity = smoothstep(0.3, 0.68, broad * 0.8 + detail * 0.2);
        const occupancy = Math.min(
          1,
          coverOccupancy * (0.12 + clusterDensity * 0.88) *
            Math.max(0, densityScale?.(x, z) ?? 1),
        );
        if (random() > occupancy) continue;
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

        const clusterCount = FERN_CLUSTER_MIN_COUNT + Math.floor(
          random() * (FERN_CLUSTER_MAX_COUNT - FERN_CLUSTER_MIN_COUNT + 1),
        );
        const clusterRotation = random() * Math.PI * 2;
        addFern(x, z, 1);
        for (let member = 1; member < clusterCount; member++) {
          const angle = clusterRotation + member * Math.PI * 2 / (clusterCount - 1) +
            (random() - 0.5) * 0.65;
          const distance = (0.45 + random() * 0.55) *
            FERN_CLUSTER_RADIUS_METERS / metersPerUnit;
          addFern(
            x + Math.cos(angle) * distance,
            z + Math.sin(angle) * distance,
            0.76 + random() * 0.28,
          );
        }
      }
      await yieldControl?.();
    }
  }

  const matrixData = await packInstanceMatrices(matrices, yieldControl);
  const fields: VegetationFieldResult[] = [];
  for (const bucket of variantBuckets.values()) {
    const suffix = `${bucket.variant.regionX}-${bucket.variant.regionY}`;
    const { root: variantRoot, impostor: fern, model: fernModel } =
      await createVegetationFieldRenderers(scene, {
        rootName: `fernField-${suffix}`,
        impostorName: `fernImpostors-${suffix}`,
        renderHeight,
        loadAssets: () => acquireFernImpostorAssets(scene, bucket.variant),
        createModel: () => createFernModel(scene, renderHeight, bucket.variant.seed),
      });
    variantRoot.parent = root;
    configureFernRenderers(fern, fernModel, meshWidth, meshDepth);
    fields.push(await createVegetationFieldResult(
      variantRoot,
      [fern],
      [fernModel],
      await packInstanceMatrices(bucket.matrices, yieldControl),
      metersPerUnit,
      renderMode,
      undefined,
      yieldControl,
    ));
  }
  return combineVegetationFieldResults(root, fields, matrixData);

  function addFern(x: number, z: number, clusterScale: number): void {
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

    const elevation = sampleElevation(terrain, x, z, meshWidth, meshDepth);
    const heightScale = (0.68 + random() * 0.64) * clusterScale;
    const widthScale = (0.92 + random() * 0.68) * clusterScale;
    const yaw = random() * Math.PI * 2;
    const pitch = (random() - 0.5) * 0.06;
    const roll = (random() - 0.5) * 0.06;
    const matrix = Matrix.Compose(
      new Vector3(widthScale, heightScale, widthScale),
      new Vector3(pitch, yaw, roll).toQuaternion(),
      new Vector3(
        x,
        (elevation + FERN_GROUND_OFFSET_METERS) / metersPerUnit,
        z,
      ),
    );
    const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
    matrices.push(matrix);
    addProceduralVariantPlacement(
      variantBuckets,
      "ferns",
      lon,
      lat,
      modelVariantSeed,
      matrix,
    );
  }
}

function configureFernRenderers(
  fern: import("@babylonjs/core").Mesh,
  fernModel: import("@babylonjs/core").Mesh,
  meshWidth: number,
  meshDepth: number,
): void {
  setVegetationWindShear([fern, fernModel], windShearFraction("grass") * 0.65);
  if (fern.material instanceof ShaderMaterial) {
    fern.material.setFloat("impostorLodNear", 28);
    fern.material.setFloat("impostorLodFar", 58);
    fern.material.setFloat("distanceFadeNear", Math.min(meshWidth, meshDepth) * 0.8);
    fern.material.setFloat("distanceFadeFar", Math.min(meshWidth, meshDepth) * 1.75);
    fern.material.setFloat("groundColorBlend", 0.14);
    fern.material.setFloat("vegetationShadowAtInstanceRoot", 1);
    fern.material.setFloat("vegetationShadowDarkness", SHADOW_DARKNESS);
    fern.material.setColor3("distanceGroundColor", new Color3(0.12, 0.25, 0.09));
  }
  if (fernModel.material instanceof ShaderMaterial) {
    fernModel.material.setFloat("vegetationShadowAtInstanceRoot", 1);
    fernModel.material.setFloat("vegetationShadowDarkness", SHADOW_DARKNESS);
    fernModel.material.setFloat("groundColorBlend", 0.14);
    fernModel.material.setColor3("distanceGroundColor", new Color3(0.12, 0.25, 0.09));
  }
}
