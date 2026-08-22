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
import { createGrassModel, getGrassImpostorAssets } from "./GrassImpostor";
import { setVegetationWindShear } from "./ProceduralCaptureMaterial";
import { windShearFraction } from "./Wind";
import { createImpostorPrototypeFromAssets } from "./TreeField";
import type { TerrainData } from "./TerrainData";
import { createVegetationFieldResult, VegetationFieldResult } from "./VegetationField";
import { LandCoverClass, landCoverSurfaceColor } from "./WorldCover";
import { varyGroundColor } from "./GroundVariation";
import { createSeededRandom } from "./Random";
import {
  createPlacementGrid,
  packInstanceMatrices,
  VegetationPlacementOptions,
} from "./VegetationPlacement";

/** Keeps the broad grass patch above small terrain interpolation differences. */
const GRASS_GROUND_OFFSET_METERS = 0.07;
const GRASS_HEIGHT_METERS = 0.55;
// A mature grass clump is about two metres wide after source scaling. Keeping
// centres comfortably inside that footprint lets neighbouring clumps overlap
// into turf instead of reading as isolated tufts.
const GRASS_SPACING_METERS = 1.3;
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
// Match the terrain receiver: full shadow removes direct sun but preserves
// hemispheric ambient light in the vegetation shaders.
const GRASS_SHADOW_DARKNESS = 0;

type GrassFieldOptions = VegetationPlacementOptions;

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
  for (const mesh of field.impostorMeshes) {
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
    spacingMeters = GRASS_SPACING_METERS,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    densityScale,
    renderMode = "auto",
    yieldControl,
    startDisabled = false,
  } = options;
  const grassHeight = GRASS_HEIGHT_METERS / metersPerUnit;
  const root = new TransformNode("grassField", scene);
  if (startDisabled) root.setEnabled(false);
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
    grass.material.setFloat("instanceColorCoverage", 1);
    const fade = grassDistanceFadeRange(
      Math.min(meshWidth, meshDepth),
      DEFAULT_DETAIL_TILES_ACROSS,
    );
    grass.material.setFloat("distanceFadeNear", fade.near);
    grass.material.setFloat("distanceFadeFar", fade.far);
    grass.material.setFloat("groundColorBlend", GRASS_GROUND_COLOR_BLEND);
    grass.material.setFloat("distanceGroundBlend", 1);
    grass.material.setFloat("impostorAmbientUpward", GRASS_AMBIENT_UPWARD);
    grass.material.setFloat("vegetationShadowAtInstanceRoot", 1);
    grass.material.setFloat("vegetationShadowDarkness", GRASS_SHADOW_DARKNESS);
    grass.material.setColor3(
      "distanceGroundColor",
      Color3.FromArray(GRASSLAND_REFERENCE_COLOR),
    );
  }
  const grassModel = createGrassModel(scene, grassHeight);
  // Grass is rotationally symmetric, so its atlas cannot hold a directional
  // sway. A shear needs no atlas frames at all: the impostor warps its proxy
  // and the live model displaces its vertices by the same linear amount.
  setVegetationWindShear([grass, grassModel], windShearFraction("grass"));
  grassModel.parent = root;
  grassModel.isPickable = false;
  if (grassModel.material instanceof ShaderMaterial) {
    grassModel.material.setFloat("instanceColorCoverage", 1);
    grassModel.material.setFloat("groundColorBlend", GRASS_GROUND_COLOR_BLEND);
    grassModel.material.setFloat("vegetationShadowAtInstanceRoot", 1);
    grassModel.material.setFloat("vegetationShadowDarkness", GRASS_SHADOW_DARKNESS);
    grassModel.material.setColor3(
      "distanceGroundColor",
      Color3.FromArray(GRASSLAND_REFERENCE_COLOR),
    );
  }
  // Never force-dispose this material's textures: the bound shadow sampler is
  // the scene's shared shadow map, and destroying it blanks all vegetation
  // after a terrain rebuild. The material disposes its own textures itself.
  root.onDisposeObservable.add(() => grassModel.material?.dispose(true, false));
  const captureSize = prototype.captureSize;
  const random = createSeededRandom(seed);
  const { columns, rows, cellWidth, cellDepth } = createPlacementGrid(
    meshWidth,
    meshDepth,
    spacingMeters,
    metersPerUnit,
  );
  const maximumHalfWidth = captureSize * 0.72;
  const matrices: Matrix[] = [];
  const colors: number[] = [];

  if (landCover) {
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        // Restrained jitter keeps the carpet gap-free while rotations, scale,
        // and the clump silhouettes keep the underlying grid imperceptible.
        const x = -meshWidth / 2 + (column + 0.35 + random() * 0.3) * cellWidth;
        const z = meshDepth / 2 - (row + 0.35 + random() * 0.3) * cellDepth;
        const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
        const coverClass = landCover.sample(lon, lat);
        const occupancy = Math.min(
          1,
          (OCCUPANCY[coverClass] ?? 0) *
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
        const widthScale = 1.1 + random() * 0.42;
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
        colors.push(...grassGroundColorMultiplier(lon, lat, coverClass));
      }
      await yieldControl?.();
    }
  }

  const matrixData = await packInstanceMatrices(matrices, yieldControl);
  return createVegetationFieldResult(
    root,
    [grass],
    [grassModel],
    matrixData,
    metersPerUnit,
    renderMode,
    new Float32Array(colors),
    yieldControl,
  );
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
): readonly [number, number, number] {
  const ground = varyGroundColor(
    landCoverSurfaceColor(landCover),
    longitude,
    latitude,
    landCover,
  );
  return ground.map((channel, index) => {
    const ratio = channel / GRASSLAND_REFERENCE_COLOR[index];
    return clamp(1 + (ratio - 1) * GRASS_GROUND_COLOR_INFLUENCE, 0.55, 1.35);
  }) as [number, number, number];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
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
