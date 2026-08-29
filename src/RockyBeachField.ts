import {
  Color3,
  Matrix,
  Quaternion,
  Scene,
  ShaderMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "./Geo";
import {
  acquireRockyBeachImpostorAssets,
  createRockyBeachModel,
  rockyBeachRenderedCaptureSize,
} from "./RockyBeachImpostor";
import { createSeededRandom } from "./Random";
import type { TerrainData } from "./TerrainData";
import {
  combineVegetationFieldResults,
  createVegetationFieldResult,
  type VegetationFieldResult,
} from "./VegetationField";
import { createVegetationFieldRenderers } from "./VegetationFieldRenderers";
import {
  addProceduralVariantPlacement,
  createPlacementGrid,
  packInstanceMatrices,
  type ProceduralPlacementBucket,
  type VegetationPlacementOptions,
} from "./VegetationPlacement";
import { LandCoverClass, type LandCoverSampler } from "./WorldCover";
import { DEFAULT_WORLD_SEED } from "./WorldGrid";

const ROCK_PATCH_HEIGHT_METERS = 0.62;
const ROCK_PATCH_SPACING_METERS = 3.4;
const ROCK_GROUND_OFFSET_METERS = 0.025;
// Let the outer stones sit just below the shoreline so the patch reads as a
// natural intertidal band instead of stopping at an artificial hard edge.
const ROCK_WATER_FOOTPRINT_ALLOWANCE_METERS = 0.18;
const SHORE_PROBE_METERS = 9;
const SHORE_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-0.707, -0.707], [0.707, -0.707], [-0.707, 0.707], [0.707, 0.707],
];

/** Places captured stone patches in coherent bands along selected natural beaches. */
export async function createRockyBeachField(
  scene: Scene,
  terrain: TerrainData,
  options: VegetationPlacementOptions,
): Promise<VegetationFieldResult> {
  const {
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x42454143,
    modelVariantSeed = DEFAULT_WORLD_SEED,
    spacingMeters = ROCK_PATCH_SPACING_METERS,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    densityScale,
    renderMode = "auto",
    yieldControl,
    startDisabled = false,
  } = options;
  const root = new TransformNode("rockyBeachField", scene);
  if (startDisabled) root.setEnabled(false);
  const random = createSeededRandom(seed);
  const renderHeight = ROCK_PATCH_HEIGHT_METERS / metersPerUnit;
  const maximumHalfWidth = rockyBeachRenderedCaptureSize(renderHeight) * 0.53;
  const grid = createPlacementGrid(meshWidth, meshDepth, spacingMeters, metersPerUnit);
  const matrices: Matrix[] = [];
  const variantBuckets = new Map<string, ProceduralPlacementBucket>();

  if (landCover) {
    for (let row = 0; row < grid.rows; row++) {
      for (let column = 0; column < grid.columns; column++) {
        const x = -meshWidth / 2 + (column + 0.18 + random() * 0.64) * grid.cellWidth;
        const z = meshDepth / 2 - (row + 0.18 + random() * 0.64) * grid.cellDepth;
        const location = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
        const cover = landCover.sample(location.lon, location.lat);
        if (cover === LandCoverClass.Water || cover === LandCoverClass.BuiltUp) continue;
        const waterNeighbours = countWaterNeighbours(
          landCover, terrain, x, z, meshWidth, meshDepth, metersPerUnit,
        );
        if (waterNeighbours === 0) continue;

        const character = rockyBeachCharacter(location.lon, location.lat, modelVariantSeed);
        const mappedRockySurface = cover === LandCoverClass.Bare;
        const threshold = mappedRockySurface ? 0.3 : 0.72;
        if (character < threshold) continue;
        const occupancy = Math.min(
          0.96,
          ((mappedRockySurface ? 0.64 : 0.2) +
            (character - threshold) * (mappedRockySurface ? 0.8 : 0.55) +
            waterNeighbours * 0.035) *
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
          waterLineMeters - ROCK_WATER_FOOTPRINT_ALLOWANCE_METERS,
        )) continue;

        const normal = sampleTerrainNormal(
          terrain, x, z, meshWidth, meshDepth, metersPerUnit,
        );
        if (normal.y < 0.78) continue;
        const tilt = new Quaternion(normal.z, 0, -normal.x, 1 + normal.y).normalize();
        const rotation = tilt.multiply(
          Quaternion.RotationAxis(Vector3.Up(), random() * Math.PI * 2),
        );
        const widthScale = 0.82 + random() * 0.42;
        const matrix = Matrix.Compose(
          new Vector3(
            widthScale,
            0.82 + random() * 0.36,
            widthScale * (0.88 + random() * 0.24),
          ),
          rotation,
          new Vector3(
            x,
            (sampleElevation(terrain, x, z, meshWidth, meshDepth) + ROCK_GROUND_OFFSET_METERS) /
              metersPerUnit,
            z,
          ),
        );
        const cool = 0.92 + character * 0.09;
        const color: readonly [number, number, number] = [
          cool,
          cool,
          0.92 + character * 0.04,
        ];
        matrices.push(matrix);
        addProceduralVariantPlacement(
          variantBuckets,
          "rocks",
          location.lon,
          location.lat,
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
    const { root: variantRoot, impostor, model } = await createVegetationFieldRenderers(scene, {
      rootName: `rockyBeachField-${suffix}`,
      impostorName: `rockyBeachImpostors-${suffix}`,
      renderHeight,
      loadAssets: () => acquireRockyBeachImpostorAssets(scene, bucket.variant),
      createModel: () => createRockyBeachModel(scene, renderHeight, bucket.variant.seed),
    });
    variantRoot.parent = root;
    configureRockyBeachRenderers(impostor, model);
    fields.push(await createVegetationFieldResult(
      variantRoot,
      [impostor],
      [model],
      await packInstanceMatrices(bucket.matrices, yieldControl),
      metersPerUnit,
      renderMode,
      new Float32Array(bucket.colors),
      yieldControl,
    ));
  }
  return combineVegetationFieldResults(root, fields, matrixData);
}

/** World-anchored broad variation makes whole shore stretches rocky or clear. */
export function rockyBeachCharacter(longitude: number, latitude: number, seed: number): number {
  const latitudeRadians = latitude * Math.PI / 180;
  const eastMeters = longitude * 111_320 * Math.max(0.18, Math.cos(latitudeRadians));
  const northMeters = latitude * 110_540;
  const phase = (seed >>> 0) * 0.000000731;
  const broad = Math.sin(eastMeters / 155 + northMeters / 213 + phase);
  const secondary = Math.sin(eastMeters / 79 - northMeters / 117 + phase * 1.73);
  return Math.max(0, Math.min(1, 0.5 + broad * 0.31 + secondary * 0.19));
}

function countWaterNeighbours(
  landCover: LandCoverSampler,
  terrain: TerrainData,
  x: number,
  z: number,
  meshWidth: number,
  meshDepth: number,
  metersPerUnit: number,
): number {
  const probe = SHORE_PROBE_METERS / metersPerUnit;
  let count = 0;
  for (const [directionX, directionZ] of SHORE_DIRECTIONS) {
    const location = sceneToLonLat(
      x + directionX * probe,
      z + directionZ * probe,
      terrain.bounds,
      meshWidth,
      meshDepth,
    );
    if (landCover.sample(location.lon, location.lat) === LandCoverClass.Water) count++;
  }
  return count;
}

function sampleTerrainNormal(
  terrain: TerrainData,
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

function configureRockyBeachRenderers(
  impostor: import("@babylonjs/core").Mesh,
  model: import("@babylonjs/core").Mesh,
): void {
  if (impostor.material instanceof ShaderMaterial) {
    impostor.material.setFloat("impostorLodNear", 14);
    impostor.material.setFloat("impostorLodFar", 30);
    impostor.material.setFloat("instanceColorCoverage", 1);
    impostor.material.setFloat("groundColorBlend", 0.1);
    // The impostor has a single stable canopy normal; reduce its sky bias so
    // its average value matches the varied normals used by the live stones.
    impostor.material.setFloat("impostorAmbientUpward", 0.54);
    impostor.material.setFloat("vegetationShadowAtInstanceRoot", 1);
    impostor.material.setFloat("vegetationShadowDarkness", 0.42);
    impostor.material.setColor3("distanceGroundColor", new Color3(0.43, 0.42, 0.39));
  }
  if (model.material instanceof ShaderMaterial) {
    model.material.setFloat("instanceColorCoverage", 1);
    model.material.setFloat("groundColorBlend", 0.1);
    model.material.setFloat("vegetationShadowAtInstanceRoot", 1);
    model.material.setFloat("vegetationShadowDarkness", 0.42);
    model.material.setColor3("distanceGroundColor", new Color3(0.43, 0.42, 0.39));
  }
}
