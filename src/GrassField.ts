import {
  Matrix,
  Mesh,
  Quaternion,
  Scene,
  ShaderMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { HorizontalExclusionMask, isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "./Geo";
import { createGrassModel, getGrassImpostorAssets } from "./GrassImpostor";
import { createImpostorPrototypeFromAssets } from "./TreeField";
import { TerrainResult } from "./TerrainTiles";
import {
  computeVegetationOcclusion,
  createVegetationFieldResult,
  VegetationFieldResult,
  VegetationRenderMode,
} from "./VegetationField";
import { LandCoverClass, WorldCover } from "./WorldCover";

export type GrassFieldResult = VegetationFieldResult;

/** Keeps the broad grass patch above small terrain interpolation differences. */
const GRASS_GROUND_OFFSET_METERS = 0.07;
const GRASS_HEIGHT_METERS = 0.55;

interface GrassFieldOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  seed?: number;
  spacingMeters?: number;
  waterLineMeters?: number;
  landCover?: WorldCover;
  exclusionMask?: HorizontalExclusionMask;
  ambientOccluders?: readonly Float32Array[];
  densityScale?: (worldX: number, worldZ: number) => number;
  renderMode?: VegetationRenderMode;
}

const OCCUPANCY: Readonly<Partial<Record<LandCoverClass, number>>> = {
  [LandCoverClass.TreeCover]: 0.6,
  [LandCoverClass.Shrubland]: 0.7,
  [LandCoverClass.Grassland]: 0.74,
  [LandCoverClass.Cropland]: 0.74,
  [LandCoverClass.Wetland]: 0.7,
  [LandCoverClass.Mangrove]: 0.55,
  [LandCoverClass.MossAndLichen]: 0.68,
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
    spacingMeters = 2,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    ambientOccluders = [],
    densityScale,
    renderMode = "auto",
  } = options;
  const grassHeight = GRASS_HEIGHT_METERS / metersPerUnit;
  const root = new TransformNode("grassField", scene);
  const assets = await getGrassImpostorAssets(scene);
  const prototype = createImpostorPrototypeFromAssets(
    scene,
    assets,
    grassHeight,
    root,
    "grassImpostors",
  );
  const grass = prototype.mesh;
  if (grass.material instanceof ShaderMaterial) {
    // Grass occupies few pixels much sooner than trees. Retain the detailed
    // 128 px atlas through the middle distance before blending to 20 px.
    grass.material.setFloat("impostorLodNear", 40);
    grass.material.setFloat("impostorLodFar", 80);
    // The shared impostor shader flattens proxy depth onto the patch center.
    // Pull grass slightly forward so small terrain variations do not cut it off.
    grass.material.zOffset = -1;
    grass.material.zOffsetUnits = -1;
  }
  const grassModel = createGrassModel(scene, grassHeight);
  grassModel.parent = root;
  grassModel.isPickable = false;
  root.onDisposeObservable.add(() => grassModel.material?.dispose(true, true));
  const captureSize = prototype.captureSize;
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
        const occupancy = Math.min(
          1,
          (OCCUPANCY[landCover.sample(lon, lat)] ?? 0) *
            Math.max(0, densityScale?.(x, z) ?? 1),
        );
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
            new Vector3(
              x,
              (elevation + GRASS_GROUND_OFFSET_METERS) / metersPerUnit,
              z,
            ),
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
    [grass],
    [grassModel],
    matrixData,
    metersPerUnit,
    renderMode,
    instanceOcclusion,
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
