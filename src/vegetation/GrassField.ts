import {
  Color3,
  Matrix,
  Quaternion,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { isTerrainFootprintAbove, sceneToLonLat, sampleElevation, type HorizontalExclusionMask } from "../world/Geo";
import { terrainAverageAlbedo } from "../terrain/TerrainTextureData";
import {
  acquireGrassImpostorAssets,
  createGrassModel,
  grassRenderedCaptureSize,
  grassRenderedClumpRadius,
} from "./GrassImpostor";
import { setVegetationWindShear } from "../procedural/ProceduralCaptureMaterial";
import { windShearFraction } from "./Wind";
import type { TerrainData } from "../terrain/TerrainData";
import type { VegetationFieldResult } from "./VegetationField";
import { createRegionalVegetationField } from "./VegetationFieldRenderers";
import { configureVegetationMaterials } from "./VegetationMaterial";
import { LandCoverClass, landCoverSurfaceColor } from "../world/WorldCover";
import { varyGroundColor } from "../terrain/GroundVariation";
import {
  createFieldPlacement,
  addProceduralVariantPlacement,
  packInstanceMatrices,
  sampleTerrainNormal,
  VegetationPlacementOptions,
} from "./VegetationPlacement";
import { DEFAULT_WORLD_SEED } from "../world/WorldGrid";
import { vegetationDistanceFadeRange as grassDistanceFadeRange } from "./DistanceDropout";

/** Keeps the broad grass patch above small terrain interpolation differences. */
const GRASS_GROUND_OFFSET_METERS = 0.07;
const GRASS_HEIGHT_METERS = 0.55;
// Broad, sparse clumps share the same placement spacing: their low fringes
// overlap more often while the reduced blade count keeps the field open.
const GRASS_SPACING_METERS = 1.3;
/** Let the sparse outer blades reach road verges; keep the roots clear. */
const GRASS_SURFACE_CLEARANCE_METERS = 1.2;
const GRASS_RIVER_CLEARANCE_SCALE = 0.75;
const GRASSLAND_REFERENCE_COLOR = landCoverSurfaceColor(LandCoverClass.Grassland);
const DEFAULT_DETAIL_TILES_ACROSS = 3;
// Retain blade variation while anchoring brightness and saturation to ground.
const GRASS_GROUND_COLOR_BLEND = 0.72;
/** Per-instance width spread applied at placement, kept as its own constants
 * so the impostor's depth plane can account for the average clump footprint. */
const GRASS_WIDTH_SCALE_MINIMUM = 1.1;
const GRASS_WIDTH_SCALE_SPAN = 0.42;

interface GrassFieldOptions extends VegetationPlacementOptions {
  /** Walls need clearance for the full clump, including its wind-driven fringe. */
  buildingExclusionMask?: HorizontalExclusionMask;
  /** Lake outlines exclude the full grass clump footprint. */
  lakeExclusionMask?: HorizontalExclusionMask;
  /** Allow the sparse clump fringe to reach closer to river banks. */
  riverExclusionMask?: HorizontalExclusionMask;
}

const OCCUPANCY: Readonly<Partial<Record<LandCoverClass, number>>> = {
  [LandCoverClass.TreeCover]: 0.72,
  [LandCoverClass.Shrubland]: 0.84,
  // These covers represent continuous low vegetation. Full occupancy is
  // intentional: variation comes from overlapping clumps, not bare grid cells.
  [LandCoverClass.Grassland]: 1,
  [LandCoverClass.Cropland]: 1,
  [LandCoverClass.Wetland]: 0.88,
  [LandCoverClass.Mangrove]: 0.68,
  [LandCoverClass.MossAndLichen]: 0.82,
};

/** Places procedurally captured grass clumps over vegetated WorldCover cells. */
export async function createGrassField(
  scene: Scene,
  terrain: TerrainData,
  options: GrassFieldOptions,
): Promise<VegetationFieldResult> {
  const {
    meshWidth, meshDepth, metersPerUnit, modelVariantSeed, waterLineMeters,
    landCover, exclusionMask, buildingExclusionMask, lakeExclusionMask, riverExclusionMask, densityScale, renderMode, yieldControl,
    root, random, columns, rows, cellWidth, cellDepth, matrices,
    renderHeight: grassHeight, variantBuckets,
  } = createFieldPlacement(scene, "grassField", options, {
    seed: 0x47524153, spacingMeters: GRASS_SPACING_METERS, heightMeters: GRASS_HEIGHT_METERS,
  });
  const maximumHalfWidth = grassRenderedCaptureSize(grassHeight) * 0.72;
  const buildingClearance = maximumHalfWidth + 0.35 / metersPerUnit;

  // Snow whitens the ground before the shared low-plant density reaches zero.
  // Keep summer-green grass out of snowy tiles, including light winter cover.
  if (landCover && (options.snowCover ?? 0) <= 0) {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        // Let neighbouring clumps overlap irregularly. Their generous width
        // still closes gaps, while the wider jitter prevents the first and
        // last occupied rows from reading as a straight strip.
        const x = -meshWidth / 2 + (column + 0.18 + random() * 0.64) * cellWidth;
        const z = meshDepth / 2 - (row + 0.18 + random() * 0.64) * cellDepth;
        const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
        const coverClass = landCover.sample(lon, lat);
        const occupancy = Math.min(
          1,
          (OCCUPANCY[coverClass] ?? 0) *
            Math.max(0, densityScale?.(x, z) ?? 1),
        );
        if (random() > occupancy) continue;

        const elevation = sampleElevation(terrain, x, z, meshWidth, meshDepth);
        if (exclusionMask?.intersects(x, z, GRASS_SURFACE_CLEARANCE_METERS / metersPerUnit)) continue;
        if (buildingExclusionMask?.intersects(x, z, buildingClearance)) continue;
        if (lakeExclusionMask?.intersects(x, z, maximumHalfWidth)) continue;
        if (riverExclusionMask?.intersects(x, z, maximumHalfWidth * GRASS_RIVER_CLEARANCE_SCALE)) continue;
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
        const widthScale = GRASS_WIDTH_SCALE_MINIMUM + random() * GRASS_WIDTH_SCALE_SPAN;
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
        const matrix = Matrix.Compose(
            new Vector3(widthScale, heightScale, widthScale),
            rotation,
            new Vector3(
              x,
              (elevation + GRASS_GROUND_OFFSET_METERS) / metersPerUnit,
              z,
            ),
          );
        const surfaceColor = landCover.sampleSurfaceColor?.(lon, lat) ??
          landCoverSurfaceColor(coverClass);
        const color = grassGroundColorMultiplier(
          lon,
          lat,
          coverClass,
          surfaceColor,
          modelVariantSeed,
        );
        matrices.push(matrix);
        addProceduralVariantPlacement(
          variantBuckets,
          "grass",
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
  return createRegionalVegetationField(
    scene, root, variantBuckets.values(), matrixData,
    { metersPerUnit, renderMode, yieldControl, snowCover: options.snowCover },
    (bucket, suffix) => ({
      rootName: `grassField-${suffix}`,
      impostorName: `grassImpostors-${suffix}`,
      renderHeight: grassHeight,
      loadAssets: () => acquireGrassImpostorAssets(scene, bucket.variant),
      createModel: () => createGrassModel(scene, grassHeight, bucket.variant.seed),

      configure: (grass, grassModel) => configureGrassRenderers(grass, grassModel, meshWidth, meshDepth, grassHeight),
    }),
  );
}

/**
 * Distance the impostor's depth plane moves toward the camera. A clump is
 * roughly three times wider than it is tall, so depth taken at its centre lets
 * the ground under its near edge occlude the lower half of the captured image.
 * The average placed footprint puts that edge here.
 */
export function grassImpostorDepthPull(renderHeight: number): number {
  const averageWidthScale = GRASS_WIDTH_SCALE_MINIMUM + GRASS_WIDTH_SCALE_SPAN / 2;
  return grassRenderedClumpRadius(renderHeight) * averageWidthScale;
}

function configureGrassRenderers(
  grass: import("@babylonjs/core").Mesh,
  grassModel: import("@babylonjs/core").Mesh,
  meshWidth: number,
  meshDepth: number,
  grassHeight: number,
): void {
  const albedo = terrainAverageAlbedo();
  const distanceGroundColor = Color3.FromArray(
    GRASSLAND_REFERENCE_COLOR.map((channel, index) => channel * albedo[index]),
  );
  const fade = grassDistanceFadeRange(
    Math.min(meshWidth, meshDepth),
    DEFAULT_DETAIL_TILES_ACROSS,
  );
  configureVegetationMaterials([grass, grassModel], {
    floats: {
      instanceColorCoverage: 1,
      groundColorBlend: GRASS_GROUND_COLOR_BLEND,
      vegetationShadowAtInstanceRoot: 1,
      terrainLighting: 1,
      // Both LODs thin out over the same range so a clump's model and impostor
      // shrink and drop together (see DistanceDropout).
      distanceFadeNear: fade.near,
      distanceFadeFar: fade.far,
    },
    colors: { distanceGroundColor },
  });
  configureVegetationMaterials([grass], {
    floats: {
      impostorDepthPull: grassImpostorDepthPull(grassHeight),
      impostorLodNear: 40,
      impostorLodFar: 80,
      // Surviving clumps stay opaque and full colour right up to the edge.
      // Pulling them toward the flat reference green removed the atlas' blade
      // shadowing and lit up the whole transition as a bright band between the
      // near grass and the bare ground.
      distanceGroundBlend: GRASS_GROUND_COLOR_BLEND,
      // A grass clump is three times wider than it is tall, so the impostor's
      // height term reads the proxy entry height rather than blade height and
      // lit whole clumps as canopy tops. The gradient is baked into the grass
      // atlas at capture instead (see GrassImpostor), matching the live model.
      crownLightStrength: 0,
    },
  });
  setVegetationWindShear([grass, grassModel], windShearFraction("grass"));
}

/**
 * Encodes the local ground tint relative to grassland. Preserve the full ratio
 * so dark forest floors and pale, dry ground retain their brightness and hue.
 */
export function grassGroundColorMultiplier(
  longitude: number,
  latitude: number,
  landCover: LandCoverClass,
  surfaceColor = landCoverSurfaceColor(landCover),
  worldSeed = DEFAULT_WORLD_SEED,
): readonly [number, number, number] {
  const ground = varyGroundColor(
    surfaceColor,
    longitude,
    latitude,
    landCover,
    0,
    worldSeed,
  );
  return ground.map((channel, index) =>
    channel / GRASSLAND_REFERENCE_COLOR[index],
  ) as [number, number, number];
}
