import {
  Color3,
  Matrix,
  Quaternion,
  Scene,
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
  type VegetationFieldResult,
} from "./VegetationField";
import { createRegionalVegetationField } from "./VegetationFieldRenderers";
import { configureVegetationMaterials } from "./VegetationMaterial";
import {
  addProceduralVariantPlacement,
  createPlacementGrid,
  packInstanceMatrices,
  sampleTerrainNormal,
  type ProceduralPlacementBucket,
  type VegetationPlacementOptions,
} from "./VegetationPlacement";
import { LandCoverClass, type LandCoverSampler } from "./WorldCover";
import { DEFAULT_WORLD_SEED } from "./WorldGrid";

const ROCK_PATCH_HEIGHT_METERS = 0.62;
const ROCK_PATCH_SPACING_METERS = 3;
const ROCK_GROUND_OFFSET_METERS = 0.025;
// Let the outer stones sit just below the shoreline so the patch reads as a
// natural intertidal band instead of stopping at an artificial hard edge.
const ROCK_WATER_FOOTPRINT_ALLOWANCE_METERS = 1.6;
// WorldCover shore pixels and the elevation shoreline rarely coincide exactly.
// A wider probe produces a continuous intertidal band instead of a single thin
// row of cards hugging the classified water edge.
const SHORE_PROBE_METERS = 24;
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
        if (cover === LandCoverClass.BuiltUp) continue;
        const shoreNeighbours = countShoreNeighbours(
          landCover, terrain, x, z, meshWidth, meshDepth, metersPerUnit,
        );
        const submerged = cover === LandCoverClass.Water;
        if (submerged ? shoreNeighbours.land === 0 : shoreNeighbours.water === 0) continue;

        const character = rockyBeachCharacter(location.lon, location.lat, modelVariantSeed);
        const mappedRockySurface = cover === LandCoverClass.Bare;
        const threshold = mappedRockySurface ? 0.24 : 0.62;
        if (character < threshold) continue;
        const occupancy = Math.min(
          0.96,
          ((mappedRockySurface ? 0.72 : 0.28) +
            (character - threshold) * (mappedRockySurface ? 0.82 : 0.64) +
            shoreNeighbours.water * 0.04) *
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
        const elevation = sampleElevation(terrain, x, z, meshWidth, meshDepth);
        const matrix = Matrix.Compose(
          new Vector3(
            widthScale,
            0.82 + random() * 0.36,
            widthScale * (0.88 + random() * 0.24),
          ),
          rotation,
          new Vector3(
            x,
            (elevation + ROCK_GROUND_OFFSET_METERS) /
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
  return createRegionalVegetationField(
    scene, root, variantBuckets.values(), matrixData,
    { metersPerUnit, renderMode, yieldControl },
    (bucket, suffix) => ({
      rootName: `rockyBeachField-${suffix}`,
      impostorName: `rockyBeachImpostors-${suffix}`,
      renderHeight,
      // Pebbles occupy a low surface, not a camera-facing depth card.
      depth: { groundPlaneHeight: 0.08 / metersPerUnit },
      loadAssets: () => acquireRockyBeachImpostorAssets(scene, bucket.variant),
      createModel: () => createRockyBeachModel(scene, renderHeight, bucket.variant.seed),
      configure: (impostor, model) => configureRockyBeachRenderers(impostor, model),
    }),
  );
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

function countShoreNeighbours(
  landCover: LandCoverSampler,
  terrain: TerrainData,
  x: number,
  z: number,
  meshWidth: number,
  meshDepth: number,
  metersPerUnit: number,
): { water: number; land: number } {
  const probe = SHORE_PROBE_METERS / metersPerUnit;
  let water = 0;
  let land = 0;
  for (const [directionX, directionZ] of SHORE_DIRECTIONS) {
    const location = sceneToLonLat(
      x + directionX * probe,
      z + directionZ * probe,
      terrain.bounds,
      meshWidth,
      meshDepth,
    );
    if (landCover.sample(location.lon, location.lat) === LandCoverClass.Water) water++;
    else land++;
  }
  return { water, land };
}

function configureRockyBeachRenderers(
  impostor: import("@babylonjs/core").Mesh,
  model: import("@babylonjs/core").Mesh,
): void {
  configureVegetationMaterials([impostor, model], {
    floats: {
      instanceColorCoverage: 1,
      groundColorBlend: 0.1,
      vegetationShadowAtInstanceRoot: 1,
      vegetationShadowDarkness: 0.42,
    },
    colors: { distanceGroundColor: new Color3(0.43, 0.42, 0.39) },
  });
  configureVegetationMaterials([impostor], {
    floats: {
      impostorLodNear: 14,
      impostorLodFar: 30,
      impostorColorContrast: 1.2,
      // The impostor has one stable canopy normal; reduce its sky bias so its
      // average value matches the varied normals used by the live stones.
      impostorAmbientUpward: 0.54,
    },
  });
}
