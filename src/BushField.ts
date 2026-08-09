import { Matrix, Mesh, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { createBushModel, getBushImpostorAssets } from "./BushImpostor";
import { HorizontalExclusionMask, isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "./Geo";
import { createImpostorPrototypeFromAssets } from "./TreeField";
import { TerrainResult } from "./TerrainTiles";
import { LandCoverClass, WorldCover } from "./WorldCover";
import {
  computeVegetationOcclusion,
  createVegetationFieldResult,
  VegetationFieldResult,
  VegetationRenderMode,
} from "./VegetationField";

export type BushFieldResult = VegetationFieldResult;

interface BushFieldOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  seed?: number;
  spacingMeters?: number;
  waterLineMeters?: number;
  landCover?: WorldCover;
  exclusionMask?: HorizontalExclusionMask;
  renderMode?: VegetationRenderMode;
  ambientOccluders?: readonly Float32Array[];
}

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
  terrain: TerrainResult,
  options: BushFieldOptions,
): Promise<BushFieldResult> {
  const {
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x42555348,
    spacingMeters = 6,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    renderMode = "impostors",
    ambientOccluders = [],
  } = options;
  const bushHeight = 1.8 / metersPerUnit;
  const root = new TransformNode("bushField", scene);
  const assets = await getBushImpostorAssets(scene);
  const prototype = createImpostorPrototypeFromAssets(
    scene,
    assets,
    bushHeight,
    root,
    "bushImpostors",
  );
  const bush = prototype.mesh;
  const captureSize = prototype.captureSize;
  const bushModel = createBushModel(scene, bushHeight);
  bushModel.parent = root;
  bushModel.isPickable = false;
  root.onDisposeObservable.add(() => bushModel.material?.dispose(true, true));

  const random = mulberry32(seed);
  const spacing = spacingMeters / metersPerUnit;
  const columns = Math.max(1, Math.floor(meshWidth / spacing));
  const rows = Math.max(1, Math.floor(meshDepth / spacing));
  const cellWidth = meshWidth / columns;
  const cellDepth = meshDepth / rows;
  const maximumHalfWidth = captureSize * 0.71;
  const matrices: Matrix[] = [];

  if (landCover && terrain.bounds) {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = -meshWidth / 2 + (column + 0.08 + random() * 0.84) * cellWidth;
        const z = meshDepth / 2 - (row + 0.08 + random() * 0.84) * cellDepth;
        const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
        const occupancy = OCCUPANCY[landCover.sample(lon, lat)] ?? 0;
        if (random() > occupancy) continue;

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

        const heightScale = 0.68 + random() * 0.82;
        const widthScale = 0.7 + random() * 0.72;
        const yaw = random() * Math.PI * 2;
        const pitch = (random() - 0.5) * 0.05;
        const roll = (random() - 0.5) * 0.05;
        matrices.push(
          Matrix.Compose(
            new Vector3(widthScale, heightScale, widthScale),
            new Vector3(pitch, yaw, roll).toQuaternion(),
            new Vector3(x, elevation / metersPerUnit, z),
          ),
        );
      }
    }
  }

  const matrixData = new Float32Array(matrices.length * 16);
  matrices.forEach((matrix, index) => matrix.copyToArray(matrixData, index * 16));
  const instanceOcclusion = computeVegetationOcclusion(
    matrixData,
    10 / metersPerUnit,
    ambientOccluders,
  );
  return createVegetationFieldResult(
    root,
    [bush],
    [bushModel],
    matrixData,
    metersPerUnit,
    renderMode,
    instanceOcclusion,
  );
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
