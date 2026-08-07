import {
  Matrix,
  Mesh,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { HorizontalExclusionMask, isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "./Geo";
import { createGrassModel, getGrassImpostorAssets } from "./GrassImpostor";
import { createImpostorCube, createImpostorMaterial } from "./TreeField";
import { TerrainResult } from "./TerrainTiles";
import {
  createVegetationFieldResult,
  VegetationFieldResult,
  VegetationRenderMode,
} from "./VegetationField";
import { LandCoverClass, WorldCover } from "./WorldCover";

export type GrassFieldResult = VegetationFieldResult;

interface GrassFieldOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  seed?: number;
  spacingMeters?: number;
  waterLineMeters?: number;
  landCover?: WorldCover;
  exclusionMask?: HorizontalExclusionMask;
  renderMode?: VegetationRenderMode;
}

const OCCUPANCY: Readonly<Partial<Record<LandCoverClass, number>>> = {
  [LandCoverClass.TreeCover]: 0.68,
  [LandCoverClass.Shrubland]: 0.94,
  [LandCoverClass.Grassland]: 1,
  [LandCoverClass.Cropland]: 1,
  [LandCoverClass.Wetland]: 0.94,
  [LandCoverClass.Mangrove]: 0.58,
  [LandCoverClass.MossAndLichen]: 0.88,
};

/** Places procedurally captured grass clumps over vegetated WorldCover cells. */
export async function createGrassField(
  scene: Scene,
  terrain: TerrainResult,
  options: GrassFieldOptions,
): Promise<GrassFieldResult> {
  const {
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x47524153,
    spacingMeters = 3,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    renderMode = "impostors",
  } = options;
  const grassHeight = 0.42 / metersPerUnit;
  const root = new TransformNode("grassField", scene);
  const assets = await getGrassImpostorAssets(scene);
  const captureSize = grassHeight * (assets.captureDiameter / assets.sourceHeight);
  const grass = createImpostorCube(
    scene,
    captureSize,
    grassHeight / 2,
    "grassImpostors",
  );
  grass.parent = root;
  grass.isPickable = false;

  const material = createImpostorMaterial(
    scene,
    assets,
    grassHeight,
    captureSize,
    "grassImpostorMaterial",
  );
  root.onDisposeObservable.add(() => material.dispose(false, false));
  grass.material = material;
  const grassModel = createGrassModel(scene, grassHeight);
  grassModel.parent = root;
  grassModel.isPickable = false;
  root.onDisposeObservable.add(() => grassModel.material?.dispose(true, true));

  const random = mulberry32(seed);
  const spacing = spacingMeters / metersPerUnit;
  const columns = Math.max(1, Math.floor(meshWidth / spacing));
  const rows = Math.max(1, Math.floor(meshDepth / spacing));
  const cellWidth = meshWidth / columns;
  const cellDepth = meshDepth / rows;
  const maximumHalfWidth = captureSize * 0.72;
  const matrices: Matrix[] = [];

  if (landCover && terrain.bounds) {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = -meshWidth / 2 + (column + 0.15 + random() * 0.7) * cellWidth;
        const z = meshDepth / 2 - (row + 0.15 + random() * 0.7) * cellDepth;
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

        const heightScale = 0.72 + random() * 0.56;
        const widthScale = 0.94 + random() * 0.5;
        const yaw = random() * Math.PI * 2;
        const normal = sampleTerrainNormal(
          terrain,
          x,
          z,
          meshWidth,
          meshDepth,
          metersPerUnit,
        );
        const tilt = new Quaternion(normal.z, 0, -normal.x, 1 + normal.y).normalize();
        const rotation = tilt.multiply(Quaternion.RotationAxis(Vector3.Up(), yaw));
        matrices.push(
          Matrix.Compose(
            new Vector3(widthScale, heightScale, widthScale),
            rotation,
            new Vector3(x, elevation / metersPerUnit, z),
          ),
        );
      }
    }
  }

  const matrixData = new Float32Array(matrices.length * 16);
  matrices.forEach((matrix, index) => matrix.copyToArray(matrixData, index * 16));
  return createVegetationFieldResult(
    root,
    [grass],
    [grassModel],
    matrixData,
    metersPerUnit,
    renderMode,
  );
}

function sampleTerrainNormal(
  terrain: TerrainResult,
  x: number,
  z: number,
  meshWidth: number,
  meshDepth: number,
  metersPerUnit: number,
): Vector3 {
  const step = 1.5 / metersPerUnit;
  const left = sampleElevation(terrain, x - step, z, meshWidth, meshDepth) / metersPerUnit;
  const right = sampleElevation(terrain, x + step, z, meshWidth, meshDepth) / metersPerUnit;
  const back = sampleElevation(terrain, x, z - step, meshWidth, meshDepth) / metersPerUnit;
  const front = sampleElevation(terrain, x, z + step, meshWidth, meshDepth) / metersPerUnit;
  return new Vector3(left - right, step * 2, back - front).normalize();
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
