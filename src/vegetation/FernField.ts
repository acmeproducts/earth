import { Color3, Matrix, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "../world/Geo";
import {
  acquireFernImpostorAssets,
  createFernModel,
  fernRenderedCaptureSize,
} from "./FernImpostor";
import { setVegetationWindShear } from "../procedural/ProceduralCaptureMaterial";
import { snowCoveredVariant } from "../rendering/Impostor";
import { habitatField } from "./HabitatNoise";
import type { HabitatFieldSpec } from "./HabitatNoise";
import { createSeededRandom } from "../core/Random";
import type { TerrainData } from "../terrain/TerrainData";
import { rainforestInfluenceAt } from "./TreeDistribution";
import {
  combineVegetationFieldResults,
  createVegetationFieldResult,
  VegetationFieldResult,
} from "./VegetationField";
import { createVegetationFieldRenderers } from "./VegetationFieldRenderers";
import { configureVegetationMaterials } from "./VegetationMaterial";
import { SHADOW_DARKNESS } from "./VegetationShadowReceiver";
import {
  createPlacementGrid,
  packInstanceMatrices,
  VegetationPlacementOptions,
} from "./VegetationPlacement";
import { proceduralVariantAtLocation, type ProceduralVariant } from "../procedural/ProceduralRegions";
import { windShearFraction } from "./Wind";
import { LandCoverClass } from "../world/WorldCover";
import { DEFAULT_WORLD_SEED } from "../world/WorldGrid";

type FernFieldOptions = VegetationPlacementOptions;

const FERN_HEIGHT_METERS = 1.05;
const FERN_SPACING_METERS = 3.8;
const FERN_GROUND_OFFSET_METERS = 0.035;
const FERN_CLUSTER_MIN_COUNT = 3;
const FERN_CLUSTER_MAX_COUNT = 5;
const FERN_CLUSTER_RADIUS_METERS = 1.8;
/**
 * Ferns arrive as damp patches on a forest floor, not as an even dusting of it.
 * The patch wavelength matches the old tile-local cluster field; the abundance
 * wavelength is new, and is what makes one wood ferny and the next one bare.
 * Calibrated so the mean density matches the field this replaced.
 */
const HABITAT: HabitatFieldSpec = {
  patchMeters: 22,
  abundanceMeters: 1800,
  barrenShare: 0.15,
  richestCoverage: 0.95,
};
/**
 * Rainforest floors are ferny everywhere rather than in patches, and the ferns
 * are far larger. These scale with the local rainforest share, so the layer
 * elsewhere keeps the calibration above.
 */
const RAINFOREST_STAND_FILL = 0.65;
const RAINFOREST_OCCUPANCY_BOOST = 0.9;
const RAINFOREST_VIGOR_BOOST = 0.55;
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
  const habitat = habitatField("ferns", modelVariantSeed, HABITAT);
  const { columns, rows, cellWidth, cellDepth } = createPlacementGrid(
    meshWidth,
    meshDepth,
    spacingMeters,
    metersPerUnit,
  );
  const maximumHalfWidth = fernRenderedCaptureSize(renderHeight) * 0.62;
  const matrices: Matrix[] = [];
  let variant: ProceduralVariant | undefined;

  if (landCover) {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = -meshWidth / 2 + (column + 0.14 + random() * 0.72) * cellWidth;
        const z = meshDepth / 2 - (row + 0.14 + random() * 0.72) * cellDepth;
        const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
        const coverOccupancy = OCCUPANCY[landCover.sample(lon, lat)] ?? 0;
        if (coverOccupancy === 0) continue;
        // Anchored to the location rather than to this tile's local frame, so
        // a patch crosses a tile boundary intact instead of the whole pattern
        // restarting once per tile.
        // Under a closed tropical canopy the floor is fern almost everywhere,
        // so the damp-patch habitat fills toward solid cover and the plants
        // themselves grow toward tree-fern size.
        const rainforest = rainforestInfluenceAt(lon, lat);
        const stand = habitat.sample(lon, lat) * (1 - rainforest * RAINFOREST_STAND_FILL)
          + rainforest * RAINFOREST_STAND_FILL;
        if (stand <= 0) continue;
        const occupancy = Math.min(
          1,
          coverOccupancy * (1 + RAINFOREST_OCCUPANCY_BOOST * rainforest) * stand
            * Math.max(0, densityScale?.(x, z) ?? 1),
        );
        if (random() > occupancy) continue;
        const vigor = 1 + RAINFOREST_VIGOR_BOOST * rainforest;
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
        addFern(x, z, vigor);
        for (let member = 1; member < clusterCount; member++) {
          // Ferns grow in clumps, not in a regular wheel. A square-rooted
          // radius keeps most fronds near the parent while leaving a few
          // irregular outer plants to break up the silhouette.
          const angle = clusterRotation + random() * Math.PI * 2;
          const distance = Math.sqrt(0.12 + random() * 0.88) *
            FERN_CLUSTER_RADIUS_METERS / metersPerUnit;
          addFern(
            x + Math.cos(angle) * distance,
            z + Math.sin(angle) * distance,
            (0.76 + random() * 0.28) * vigor,
          );
        }
      }
      await yieldControl?.();
    }
  }

  const matrixData = await packInstanceMatrices(matrices, yieldControl);
  const fields: VegetationFieldResult[] = [];
  // Ferns are small undergrowth and do not benefit from a separate regional
  // silhouette. Keep one renderer per terrain tile instead of one impostor
  // mesh for every regional bucket touched by the tile.
  if (variant) {
    const selectedVariant = snowCoveredVariant(variant, options.snowCover ?? 0);
    const { root: variantRoot, impostor: fern, model: fernModel } =
      await createVegetationFieldRenderers(scene, {
        rootName: "fernField-renderer",
        impostorName: "fernImpostors",
        renderHeight,
        loadAssets: () => acquireFernImpostorAssets(scene, selectedVariant),
        createModel: () => createFernModel(scene, renderHeight, selectedVariant.seed),
        snowCover: selectedVariant.snowCover,
      });
    variantRoot.parent = root;
    configureFernRenderers(fern, fernModel, meshWidth, meshDepth);
    fields.push(await createVegetationFieldResult(
      variantRoot,
      [fern],
      [fernModel],
      matrixData,
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
    matrices.push(matrix);
    // All ferns use the variant of the first accepted placement.
    if (!variant) {
      const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
      variant = proceduralVariantAtLocation("ferns", lon, lat, modelVariantSeed);
    }
  }
}

function configureFernRenderers(
  fern: import("@babylonjs/core").Mesh,
  fernModel: import("@babylonjs/core").Mesh,
  meshWidth: number,
  meshDepth: number,
): void {
  setVegetationWindShear([fern, fernModel], windShearFraction("grass") * 0.65);
  configureVegetationMaterials([fern, fernModel], {
    floats: {
      groundColorBlend: 0.14,
      vegetationShadowAtInstanceRoot: 1,
      vegetationShadowDarkness: SHADOW_DARKNESS,
    },
    colors: { distanceGroundColor: new Color3(0.12, 0.25, 0.09) },
  });
  configureVegetationMaterials([fern], {
    floats: {
      impostorLodNear: 28,
      impostorLodFar: 58,
      distanceFadeNear: Math.min(meshWidth, meshDepth) * 0.8,
      distanceFadeFar: Math.min(meshWidth, meshDepth) * 1.75,
    },
  });
}
