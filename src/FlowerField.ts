import { Matrix, Quaternion, Scene, ShaderMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { HorizontalExclusionMask, isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "./Geo";
import { createFlowerModel, getFlowerImpostorAssets } from "./FlowerImpostor";
import { SimplexNoise2D } from "./SimplexNoise";
import { TerrainResult } from "./TerrainTiles";
import { createImpostorPrototypeFromAssets } from "./TreeField";
import {
  computeVegetationOcclusion,
  createVegetationFieldResult,
  VegetationFieldResult,
  VegetationRenderMode,
} from "./VegetationField";
import { LandCoverClass, WorldCover } from "./WorldCover";

interface FlowerFieldOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  seed?: number;
  spacingMeters?: number;
  waterLineMeters?: number;
  landCover?: WorldCover;
  exclusionMask?: HorizontalExclusionMask;
  ambientOccluders?: readonly Float32Array[];
  renderMode?: VegetationRenderMode;
}

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
  terrain: TerrainResult,
  options: FlowerFieldOptions,
): Promise<VegetationFieldResult> {
  const {
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x464c4f57,
    spacingMeters = 2.35,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    ambientOccluders = [],
    renderMode = "auto",
  } = options;
  const flowerHeight = 0.92 / metersPerUnit;
  const root = new TransformNode("flowerField", scene);
  const assets = await getFlowerImpostorAssets(scene);
  const prototype = createImpostorPrototypeFromAssets(
    scene,
    assets,
    flowerHeight,
    root,
    "flowerImpostors",
  );
  if (prototype.mesh.material instanceof ShaderMaterial) {
    prototype.mesh.material.setFloat("impostorLodNear", 20);
    prototype.mesh.material.setFloat("impostorLodFar", 50);
  }
  const flowerModel = createFlowerModel(scene, flowerHeight);
  flowerModel.parent = root;
  flowerModel.isPickable = false;
  root.onDisposeObservable.add(() => flowerModel.material?.dispose(true, true));
  const random = mulberry32(seed);
  const clusterNoise = new SimplexNoise2D(seed ^ 0x9e3779b9);
  const regionalNoise = new SimplexNoise2D(seed ^ 0x243f6a88);
  const colorNoise = new SimplexNoise2D(seed ^ 0xb7e15162);
  const spacing = spacingMeters / metersPerUnit;
  const columns = Math.max(1, Math.floor(meshWidth / spacing));
  const rows = Math.max(1, Math.floor(meshDepth / spacing));
  const cellWidth = meshWidth / columns;
  const cellDepth = meshDepth / rows;
  const patchScale = 28 / metersPerUnit;
  const regionScale = 180 / metersPerUnit;
  const colorScale = 1.25 / metersPerUnit;
  const maximumHalfWidth = prototype.captureSize * 0.68;
  const matrices: Matrix[] = [];
  const colors: number[] = [];

  if (landCover && terrain.bounds) {
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
        matrices.push(Matrix.Compose(
          new Vector3(scale * (0.9 + random() * 0.2), scale, scale * (0.9 + random() * 0.2)),
          Quaternion.RotationAxis(Vector3.Up(), random() * Math.PI * 2),
          new Vector3(x, elevation / metersPerUnit, z),
        ));
        colors.push(...sampleFlowerColor(colorNoise, x / colorScale, z / colorScale));
      }
    }
  }

  const matrixData = new Float32Array(matrices.length * 16);
  matrices.forEach((matrix, index) => matrix.copyToArray(matrixData, index * 16));
  const instanceOcclusion = computeVegetationOcclusion(
    matrixData,
    8 / metersPerUnit,
    ambientOccluders,
  );
  return createVegetationFieldResult(
    root,
    [prototype.mesh],
    [flowerModel],
    matrixData,
    metersPerUnit,
    renderMode,
    instanceOcclusion,
    new Float32Array(colors),
  );
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

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
