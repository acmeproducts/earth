import {
  Color3,
  Matrix,
  Quaternion,
  Scene,
  ShaderMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { isTerrainFootprintAbove, sceneToLonLat, sampleElevation, type HorizontalExclusionMask } from "../world/Geo";
import { clamp } from "../core/MathUtils";
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
import { createSeededRandom } from "../core/Random";
import {
  createPlacementGrid,
  addProceduralVariantPlacement,
  packInstanceMatrices,
  sampleTerrainNormal,
  ProceduralPlacementBucket,
  VegetationPlacementOptions,
} from "./VegetationPlacement";
import { DEFAULT_WORLD_SEED } from "../world/WorldGrid";

/** Keeps the broad grass patch above small terrain interpolation differences. */
const GRASS_GROUND_OFFSET_METERS = 0.07;
const GRASS_HEIGHT_METERS = 0.55;
// Broad, sparse clumps share the same placement spacing: their low fringes
// overlap more often while the reduced blade count keeps the field open.
const GRASS_SPACING_METERS = 1.3;
/** Let the sparse outer blades reach road verges; keep the roots clear. */
const GRASS_SURFACE_CLEARANCE_METERS = 1.2;
/** How strongly each clump adopts the hue and brightness of its local ground. */
const GRASS_GROUND_COLOR_INFLUENCE = 1;
const GRASSLAND_REFERENCE_COLOR = landCoverSurfaceColor(LandCoverClass.Grassland);
/** Keeps the established 3 x 3 fade just inside its former two-tile reach. */
const GRASS_FADE_EDGE_INSET_TILE_WIDTHS = 0.05;
const GRASS_FADE_TRANSITION_TILE_WIDTHS = 1.1;
const DEFAULT_DETAIL_TILES_ACROSS = 3;
const GRASS_GROUND_COLOR_BLEND = 0.42;
/** Average upward response of the crossed grass cards in the live model. */
const GRASS_AMBIENT_UPWARD = 0.58;
// Crossed blade cards have more self-darkening than the comparatively flat
// terrain. Retain a little direct fill in full shadow so grass settles into
// the shaded ground instead of forming an unnaturally darker carpet over it.
const GRASS_SHADOW_DARKNESS = 0.3;
/** Per-instance width spread applied at placement, kept as its own constants
 * so the impostor's depth plane can account for the average clump footprint. */
const GRASS_WIDTH_SCALE_MINIMUM = 1.1;
const GRASS_WIDTH_SCALE_SPAN = 0.42;

interface GrassFieldOptions extends VegetationPlacementOptions {
  /** Lake outlines use the full clump footprint, independently of road clearance. */
  lakeExclusionMask?: HorizontalExclusionMask;
}

export interface GrassDistanceFadeRange {
  near: number;
  far: number;
}
/** Resolves the radial grass dissolve from the active full-detail tile count. */
export function grassDistanceFadeRange(
  tileWidth: number,
  detailTilesAcross: number,
): GrassDistanceFadeRange {
  const width = Math.max(0, tileWidth);
  const size = Math.max(1, Math.round(detailTilesAcross));
  const far = width * (
    (size + 1) / 2 - GRASS_FADE_EDGE_INSET_TILE_WIDTHS
  );
  return {
    near: Math.max(0, far - width * GRASS_FADE_TRANSITION_TILE_WIDTHS),
    far,
  };
}

/** Updates an existing field without rebuilding its grass instances. */
export function setGrassFieldDetailDistance(
  field: VegetationFieldResult,
  tileWidth: number,
  detailTilesAcross: number,
): void {
  const fade = grassDistanceFadeRange(tileWidth, detailTilesAcross);
  for (const mesh of [...field.impostorMeshes, ...field.modelMeshes]) {
    if (!(mesh.material instanceof ShaderMaterial)) continue;
    mesh.material.setFloat("distanceFadeNear", fade.near);
    mesh.material.setFloat("distanceFadeFar", fade.far);
  }
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
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x47524153,
    modelVariantSeed = DEFAULT_WORLD_SEED,
    spacingMeters = GRASS_SPACING_METERS,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    lakeExclusionMask,
    densityScale,
    renderMode = "auto",
    yieldControl,
    startDisabled = false,
  } = options;
  const grassHeight = GRASS_HEIGHT_METERS / metersPerUnit;
  const root = new TransformNode("grassField", scene);
  if (startDisabled) root.setEnabled(false);
  const random = createSeededRandom(seed);
  const { columns, rows, cellWidth, cellDepth } = createPlacementGrid(
    meshWidth,
    meshDepth,
    spacingMeters,
    metersPerUnit,
  );
  const maximumHalfWidth = grassRenderedCaptureSize(grassHeight) * 0.72;
  const matrices: Matrix[] = [];
  const variantBuckets = new Map<string, ProceduralPlacementBucket>();

  if (landCover) {
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
        if (lakeExclusionMask?.intersects(x, z, maximumHalfWidth)) continue;
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
    { metersPerUnit, renderMode, yieldControl },
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
  const distanceGroundColor = Color3.FromArray(GRASSLAND_REFERENCE_COLOR);
  const fade = grassDistanceFadeRange(
    Math.min(meshWidth, meshDepth),
    DEFAULT_DETAIL_TILES_ACROSS,
  );
  configureVegetationMaterials([grass, grassModel], {
    floats: {
      instanceColorCoverage: 1,
      groundColorBlend: GRASS_GROUND_COLOR_BLEND,
      vegetationShadowAtInstanceRoot: 1,
      vegetationShadowDarkness: GRASS_SHADOW_DARKNESS,
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
      impostorAmbientUpward: GRASS_AMBIENT_UPWARD,
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
 * Converts the local rendered ground color into a restrained RGB multiplier.
 * Grassland is the neutral reference, so blade-level color variation survives;
 * other covers and world-anchored dry/lush bands pull the whole clump toward
 * the terrain beneath it.
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
  return ground.map((channel, index) => {
    const ratio = channel / GRASSLAND_REFERENCE_COLOR[index];
    return clamp(1 + (ratio - 1) * GRASS_GROUND_COLOR_INFLUENCE, 0.55, 1.35);
  }) as [number, number, number];
}
