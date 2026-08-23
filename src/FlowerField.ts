import { Matrix, Quaternion, Scene, ShaderMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "./Geo";
import { smoothstep } from "./MathUtils";
import {
  acquireFlowerImpostorAssets,
  createFlowerModel,
  flowerRenderedCaptureSize,
} from "./FlowerImpostor";
import { SimplexNoise2D } from "./SimplexNoise";
import type { TerrainData } from "./TerrainData";
import {
  combineVegetationFieldResults,
  createVegetationFieldResult,
  VegetationFieldResult,
} from "./VegetationField";
import { createVegetationFieldRenderers } from "./VegetationFieldRenderers";
import { LandCoverClass } from "./WorldCover";
import { createSeededRandom } from "./Random";
import {
  createPlacementGrid,
  addProceduralVariantPlacement,
  packInstanceMatrices,
  ProceduralPlacementBucket,
  VegetationPlacementOptions,
} from "./VegetationPlacement";
import { DEFAULT_WORLD_SEED } from "./WorldGrid";

type FlowerFieldOptions = VegetationPlacementOptions;

const FLOWER_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0.96, 0.84],
  [1, 0.72, 0.12],
  [1, 0.46, 0.66],
  [0.62, 0.38, 0.94],
  [0.3, 0.62, 1],
];

/** Places rare flower colonies in grassland and tints each actor in the shader. */
export async function createFlowerField(
  scene: Scene,
  terrain: TerrainData,
  options: FlowerFieldOptions,
): Promise<VegetationFieldResult> {
  const {
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x464c4f57,
    modelVariantSeed = DEFAULT_WORLD_SEED,
    spacingMeters = 2.35,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    renderMode = "auto",
    yieldControl,
    startDisabled = false,
  } = options;
  const flowerHeight = 0.92 / metersPerUnit;
  const root = new TransformNode("flowerField", scene);
  if (startDisabled) root.setEnabled(false);
  const random = createSeededRandom(seed);
  const clusterNoise = new SimplexNoise2D(seed ^ 0x9e3779b9);
  const regionalNoise = new SimplexNoise2D(seed ^ 0x243f6a88);
  const colorNoise = new SimplexNoise2D(seed ^ 0xb7e15162);
  const { columns, rows, cellWidth, cellDepth } = createPlacementGrid(
    meshWidth,
    meshDepth,
    spacingMeters,
    metersPerUnit,
  );
  const patchScale = 28 / metersPerUnit;
  const regionScale = 180 / metersPerUnit;
  const colorScale = 1.25 / metersPerUnit;
  const maximumHalfWidth = flowerRenderedCaptureSize(flowerHeight) * 0.68;
  const matrices: Matrix[] = [];
  const variantBuckets = new Map<string, ProceduralPlacementBucket>();

  if (landCover) {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = -meshWidth / 2 + (column + 0.12 + random() * 0.76) * cellWidth;
        const z = meshDepth / 2 - (row + 0.12 + random() * 0.76) * cellDepth;
        const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
        if (landCover.sample(lon, lat) !== LandCoverClass.Grassland) continue;

        const broadNoise = clusterNoise.sample(x / patchScale, z / patchScale);
        const detailNoise = clusterNoise.sample(
          x / (patchScale * 0.38) + 31.7,
          z / (patchScale * 0.38) - 19.3,
        );
        const patchNoise = broadNoise * 0.82 + detailNoise * 0.18;
        const clusterDensity = smoothstep(0.48, 0.62, patchNoise);
        const regionDensity = smoothstep(
          0.55,
          0.68,
          regionalNoise.sample(x / regionScale + 8.1, z / regionScale - 14.6),
        );
        if (random() > clusterDensity * regionDensity * 0.96) continue;
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
        const scale = 0.9 + random() * 0.28;
        const matrix = Matrix.Compose(
          new Vector3(scale * (0.9 + random() * 0.2), scale, scale * (0.9 + random() * 0.2)),
          Quaternion.RotationAxis(Vector3.Up(), random() * Math.PI * 2),
          new Vector3(x, elevation / metersPerUnit, z),
        );
        const color = sampleFlowerColor(colorNoise, x / colorScale, z / colorScale);
        matrices.push(matrix);
        addProceduralVariantPlacement(
          variantBuckets,
          "flowers",
          lon,
          lat,
          modelVariantSeed,
          matrix,
          color,
        );
      }
      await yieldControl?.();
    }
  }

  const matrixData = await packInstanceMatrices(matrices, yieldControl);
  const fields: VegetationFieldResult[] = [];
  for (const bucket of variantBuckets.values()) {
    const suffix = `${bucket.variant.regionX}-${bucket.variant.regionY}`;
    const { root: variantRoot, impostor: flower, model: flowerModel } =
      await createVegetationFieldRenderers(scene, {
        rootName: `flowerField-${suffix}`,
        impostorName: `flowerImpostors-${suffix}`,
        renderHeight: flowerHeight,
        loadAssets: () => acquireFlowerImpostorAssets(scene, bucket.variant),
        createModel: () => createFlowerModel(scene, flowerHeight, bucket.variant.seed),
      });
    variantRoot.parent = root;
    if (flower.material instanceof ShaderMaterial) {
      flower.material.setFloat("impostorLodNear", 20);
      flower.material.setFloat("impostorLodFar", 50);
    }
    fields.push(await createVegetationFieldResult(
      variantRoot,
      [flower],
      [flowerModel],
      await packInstanceMatrices(bucket.matrices, yieldControl),
      metersPerUnit,
      renderMode,
      new Float32Array(bucket.colors),
      yieldControl,
    ));
  }
  return combineVegetationFieldResults(root, fields, matrixData);
}

/** High-frequency simplex phases avoid runs of identically colored neighbors. */
function sampleFlowerColor(noise: SimplexNoise2D, x: number, z: number): readonly number[] {
  const first = noise.sample(x, z) * 0.5 + 0.5;
  const second = noise.sample(x + 47.3, z - 28.9) * 0.5 + 0.5;
  const phase = fract(first * 3.71 + second * 2.17) * FLOWER_PALETTE.length;
  const lowIndex = Math.floor(phase);
  const highIndex = (lowIndex + 1) % FLOWER_PALETTE.length;
  const blend = smoothstep(0, 1, phase - lowIndex);
  const low = FLOWER_PALETTE[lowIndex];
  const high = FLOWER_PALETTE[highIndex];
  return [
    low[0] + (high[0] - low[0]) * blend,
    low[1] + (high[1] - low[1]) * blend,
    low[2] + (high[2] - low[2]) * blend,
  ];
}

function fract(value: number): number {
  return value - Math.floor(value);
}
