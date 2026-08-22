import { Color3, Matrix, Scene, ShaderMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "./Geo";
import { createFernModel, getFernImpostorAssets } from "./FernImpostor";
import { setVegetationWindShear } from "./ProceduralCaptureMaterial";
import { createSeededRandom } from "./Random";
import { SimplexNoise2D } from "./SimplexNoise";
import type { TerrainData } from "./TerrainData";
import { createImpostorPrototypeFromAssets } from "./TreeField";
import { createVegetationFieldResult, VegetationFieldResult } from "./VegetationField";
import {
  createPlacementGrid,
  packInstanceMatrices,
  VegetationPlacementOptions,
} from "./VegetationPlacement";
import { windShearFraction } from "./Wind";
import { LandCoverClass } from "./WorldCover";

type FernFieldOptions = VegetationPlacementOptions;

const FERN_HEIGHT_METERS = 1.05;
const FERN_SPACING_METERS = 3.8;
const FERN_GROUND_OFFSET_METERS = 0.035;
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
    spacingMeters = FERN_SPACING_METERS,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    densityScale,
    renderMode = "auto",
    yieldControl,
    startDisabled = false,
  } = options;
  const root = new TransformNode("fernField", scene);
  if (startDisabled) root.setEnabled(false);
  const renderHeight = FERN_HEIGHT_METERS / metersPerUnit;
  const assets = await getFernImpostorAssets(scene);
  const prototype = createImpostorPrototypeFromAssets(
    scene,
    assets,
    renderHeight,
    root,
    "fernImpostors",
  );
  const fern = prototype.mesh;
  const fernModel = createFernModel(scene, renderHeight);
  fernModel.parent = root;
  fernModel.isPickable = false;
  root.onDisposeObservable.add(() => fernModel.material?.dispose(true, false));
  setVegetationWindShear([fern, fernModel], windShearFraction("grass") * 0.65);
  if (fern.material instanceof ShaderMaterial) {
    fern.material.setFloat("impostorLodNear", 28);
    fern.material.setFloat("impostorLodFar", 58);
    fern.material.setFloat("distanceFadeNear", Math.min(meshWidth, meshDepth) * 0.8);
    fern.material.setFloat("distanceFadeFar", Math.min(meshWidth, meshDepth) * 1.75);
    fern.material.setFloat("groundColorBlend", 0.14);
    fern.material.setFloat("vegetationShadowAtInstanceRoot", 1);
    fern.material.setFloat("vegetationShadowDarkness", 0);
    fern.material.setColor3("distanceGroundColor", new Color3(0.12, 0.25, 0.09));
  }
  if (fernModel.material instanceof ShaderMaterial) {
    fernModel.material.setFloat("vegetationShadowAtInstanceRoot", 1);
    fernModel.material.setFloat("vegetationShadowDarkness", 0);
    fernModel.material.setFloat("groundColorBlend", 0.14);
    fernModel.material.setColor3("distanceGroundColor", new Color3(0.12, 0.25, 0.09));
  }

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
  const maximumHalfWidth = prototype.captureSize * 0.62;
  const matrices: Matrix[] = [];

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

        const elevation = sampleElevation(terrain, x, z, meshWidth, meshDepth);
        const heightScale = 0.68 + random() * 0.64;
        const widthScale = 0.78 + random() * 0.58;
        const yaw = random() * Math.PI * 2;
        const pitch = (random() - 0.5) * 0.06;
        const roll = (random() - 0.5) * 0.06;
        matrices.push(Matrix.Compose(
          new Vector3(widthScale, heightScale, widthScale),
          new Vector3(pitch, yaw, roll).toQuaternion(),
          new Vector3(
            x,
            (elevation + FERN_GROUND_OFFSET_METERS) / metersPerUnit,
            z,
          ),
        ));
      }
      await yieldControl?.();
    }
  }

  return createVegetationFieldResult(
    root,
    [fern],
    [fernModel],
    await packInstanceMatrices(matrices, yieldControl),
    metersPerUnit,
    renderMode,
    undefined,
    yieldControl,
  );
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
