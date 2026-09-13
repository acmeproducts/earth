import { Matrix, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { isTerrainFootprintAbove, sampleElevation, sceneToLonLat } from "./Geo";
import { habitatField } from "./HabitatNoise";
import { acquireWheatImpostorAssets, createWheatModel, wheatRenderedCaptureSize } from "./WheatImpostor";
import type { TerrainData } from "./TerrainData";
import type { VegetationFieldResult } from "./VegetationField";
import { createRegionalVegetationField } from "./VegetationFieldRenderers";
import { addProceduralVariantPlacement, createPlacementGrid, packInstanceMatrices } from "./VegetationPlacement";
import type { ProceduralPlacementBucket, VegetationPlacementOptions } from "./VegetationPlacement";
import { createSeededRandom } from "./Random";
import { DEFAULT_WORLD_SEED } from "./WorldGrid";
import { LandCoverClass } from "./WorldCover";
import { setVegetationWindShear } from "./procedural/ProceduralCaptureMaterial";
import { windShearFraction } from "./Wind";

const HEIGHT_METERS = 1.28;
const SPACING_METERS = 0.9;
const HABITAT = { patchMeters: 180, abundanceMeters: 2400, barrenShare: 0.5, richestCoverage: 0.92 } as const;
const OCCUPANCY = 0.72;

export async function createWheatField(scene: Scene, terrain: TerrainData, options: VegetationPlacementOptions): Promise<VegetationFieldResult> {
  const { meshWidth, meshDepth, metersPerUnit, landCover, exclusionMask, densityScale, modelVariantSeed = DEFAULT_WORLD_SEED, seed = 0x57484541, renderMode = "auto", yieldControl, startDisabled = false } = options;
  const root = new TransformNode("wheatField", scene); if (startDisabled) root.setEnabled(false);
  const random = createSeededRandom(seed); const habitat = habitatField("wheat", modelVariantSeed, HABITAT);
  const grid = createPlacementGrid(meshWidth, meshDepth, SPACING_METERS, metersPerUnit);
  const maxHalfWidth = wheatRenderedCaptureSize(HEIGHT_METERS / metersPerUnit) * 0.52;
  const buckets = new Map<string, ProceduralPlacementBucket>();
  if (landCover) for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      const x = -meshWidth / 2 + (column + 0.2 + random() * 0.6) * grid.cellWidth;
      const z = meshDepth / 2 - (row + 0.2 + random() * 0.6) * grid.cellDepth;
      const location = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
      if (landCover.sample(location.lon, location.lat) !== LandCoverClass.Cropland) continue;
      const chance = OCCUPANCY * habitat.sample(location.lon, location.lat) * Math.max(0, densityScale?.(x, z) ?? 1);
      if (random() > Math.min(1, chance) || exclusionMask?.intersects(x, z, maxHalfWidth)) continue;
      if (!isTerrainFootprintAbove(terrain, x, z, maxHalfWidth, maxHalfWidth, meshWidth, meshDepth, 0)) continue;
      const elevation = sampleElevation(terrain, x, z, meshWidth, meshDepth);
      const scale = 0.86 + random() * 0.28;
      const matrix = Matrix.Compose(new Vector3(scale, scale, scale), new Vector3(0, random() * Math.PI * 2, 0).toQuaternion(), new Vector3(x, elevation / metersPerUnit, z));
      addProceduralVariantPlacement(buckets, "wheat", location.lon, location.lat, modelVariantSeed, matrix, undefined, 3);
    }
    await yieldControl?.();
  }
  return createRegionalVegetationField(
    scene, root, buckets.values(),
    await packInstanceMatrices(
      [...buckets.values()].flatMap((bucket) => bucket.matrices),
      yieldControl,
    ),
    { metersPerUnit, renderMode, yieldControl },
    (bucket, suffix) => ({
      rootName: `wheatField-${suffix}`,
      impostorName: `wheatImpostors-${suffix}`,
      renderHeight: HEIGHT_METERS / metersPerUnit,
      loadAssets: () => acquireWheatImpostorAssets(scene, bucket.variant),
      createModel: () => createWheatModel(scene, HEIGHT_METERS / metersPerUnit, bucket.variant.seed),
      configure: (impostor, model) => setVegetationWindShear([impostor, model], windShearFraction("grass") * 1.2),
    }),
  );
}
