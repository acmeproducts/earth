import { Matrix, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { createSeededRandom } from "../core/Random";
import { habitatField, type HabitatFieldSpec } from "./HabitatNoise";
import { DEFAULT_WORLD_SEED } from "../world/WorldGrid";
import { sampleElevation, sceneToLonLat, type HorizontalExclusionMask } from "../world/Geo";
import type { TerrainData } from "../terrain/TerrainData";
import type { VegetationRenderMode } from "./VegetationField";
import type { LandCoverSampler } from "../world/WorldCover";
import type { ProceduralRegionFamily, ProceduralVariant } from "../procedural/ProceduralRegions";
import {
  proceduralLocalVariantAtLocation,
  proceduralVariantAtLocation,
} from "../procedural/ProceduralRegions";

export interface VegetationPlacementOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  seed?: number;
  /** World-level seed used for location-bound procedural model variants. */
  modelVariantSeed?: number;
  /** Calendar snapshot used by procedural vegetation generated for this world. */
  seasonalDate?: Date;
  /** Snow depth in [0, 1] lying on the tile; baked into models and atlases. */
  snowCover?: number;
  spacingMeters?: number;
  waterLineMeters?: number;
  landCover?: LandCoverSampler;
  exclusionMask?: HorizontalExclusionMask;
  densityScale?: (worldX: number, worldZ: number) => number;
  renderMode?: VegetationRenderMode;
  /** Optional cooperative yield used while streaming large placement grids. */
  yieldControl?: () => Promise<void>;
  /** Startup may capture immediately; streamed atlas work stays frame-budgeted. */
  impostorCaptureMode?: "fast" | "cooperative";
  /** Creates the field hidden so partially built meshes never flash on screen. */
  startDisabled?: boolean;
}

export function sampleTerrainNormal(
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

export interface PlacementGrid {
  columns: number;
  rows: number;
  cellWidth: number;
  cellDepth: number;
}

export function createFieldPlacement<T extends VegetationPlacementOptions>(
  scene: Scene,
  name: string,
  options: T,
  defaults: { seed: number; spacingMeters: number; heightMeters: number },
) {
  const { seed = defaults.seed, modelVariantSeed = DEFAULT_WORLD_SEED,
    spacingMeters = defaults.spacingMeters, waterLineMeters = 0,
    renderMode = "auto", startDisabled = false } = options;
  const root = new TransformNode(name, scene);
  if (startDisabled) root.setEnabled(false);
  return {
    ...options, modelVariantSeed, waterLineMeters, renderMode, root,
    renderHeight: defaults.heightMeters / options.metersPerUnit,
    random: createSeededRandom(seed),
    ...createPlacementGrid(options.meshWidth, options.meshDepth, spacingMeters, options.metersPerUnit),
    matrices: [] as Matrix[],
    variantBuckets: new Map<string, ProceduralPlacementBucket>(),
  };
}

export function createPlacementGrid(
  meshWidth: number,
  meshDepth: number,
  spacingMeters: number,
  metersPerUnit: number,
): PlacementGrid {
  const spacing = spacingMeters / metersPerUnit;
  const columns = Math.max(1, Math.floor(meshWidth / spacing));
  const rows = Math.max(1, Math.floor(meshDepth / spacing));
  return {
    columns,
    rows,
    cellWidth: meshWidth / columns,
    cellDepth: meshDepth / rows,
  };
}

export function createHabitatPlacement<T extends VegetationPlacementOptions>(
  scene: Scene,
  name: string,
  options: T,
  defaults: { seed: number; spacingMeters: number; heightMeters: number },
  layer: string,
  spec: HabitatFieldSpec,
) {
  const placement = createFieldPlacement(scene, name, options, defaults);
  return { ...placement, habitat: habitatField(layer, placement.modelVariantSeed, spec) };
}

/** Draw x before z so placement keeps the seeded random sequence stable. */
export function jitteredPlacementPoint(
  column: number, row: number,
  meshWidth: number, meshDepth: number,
  cellWidth: number, cellDepth: number,
  random: () => number,
) {
  return {
    x: -meshWidth / 2 + (column + 0.08 + random() * 0.84) * cellWidth,
    z: meshDepth / 2 - (row + 0.08 + random() * 0.84) * cellDepth,
  };
}

/** Lazily sample one row; callers can still yield between rows. */
export function* jitteredPlacementRow(
  row: number,
  grid: Pick<PlacementGrid, "columns" | "cellWidth" | "cellDepth">,
  meshWidth: number, meshDepth: number,
  bounds: TerrainData["bounds"],
  random: () => number,
) {
  for (let column = 0; column < grid.columns; column++) {
    const point = jitteredPlacementPoint(
      column, row, meshWidth, meshDepth, grid.cellWidth, grid.cellDepth, random,
    );
    yield { ...point, ...sceneToLonLat(point.x, point.z, bounds, meshWidth, meshDepth) };
  }
}

export async function packInstanceMatrices(
  matrices: readonly Matrix[],
  yieldControl?: () => Promise<void>,
): Promise<Float32Array> {
  const packed = new Float32Array(matrices.length * 16);
  for (let index = 0; index < matrices.length; index++) {
    matrices[index].copyToArray(packed, index * 16);
    if ((index & 511) === 511) await yieldControl?.();
  }
  return packed;
}

export interface ProceduralPlacementBucket {
  variant: ProceduralVariant;
  /** Sister-model index inside the region, zero for the region's own model. */
  localVariant: number;
  matrices: Matrix[];
  colors: number[];
}

export interface ProceduralVariantSelection {
  /** Optional shared anchor makes every placement in a field choose one variant. */
  longitude: number;
  latitude: number;
  localitySpanTiles?: number;
  localityBlendTiles?: number;
  /** Optional bounded sister-model offset, e.g. a secondary colony species. */
  localVariantOffset?: number;
}

/** Names one bucket's meshes uniquely, including its sister-model index. */
export function proceduralBucketSuffix(bucket: ProceduralPlacementBucket): string {
  const region = `${bucket.variant.regionX}-${bucket.variant.regionY}`;
  return bucket.localVariant === 0 ? region : `${region}-v${bucket.localVariant}`;
}

/** Adds one placement to its stable spatial model-variant bucket. */
export function addProceduralVariantPlacement(
  buckets: Map<string, ProceduralPlacementBucket>,
  family: ProceduralRegionFamily,
  longitude: number,
  latitude: number,
  modelVariantSeed: number,
  matrix: Matrix,
  color?: readonly number[],
  sisterModels = 1,
  selection?: ProceduralVariantSelection,
): void {
  const variantLongitude = selection?.longitude ?? longitude;
  const variantLatitude = selection?.latitude ?? latitude;
  const regionalVariant = proceduralVariantAtLocation(
    family,
    variantLongitude,
    variantLatitude,
    modelVariantSeed,
  );
  // Bound to the location, not to the field's random stream: a terrain tile
  // then normally builds one sister model instead of all of them, and adjacent
  // tiles reuse the same cached impostor atlas.
  const localVariant = (proceduralLocalVariantAtLocation(
    family,
    variantLongitude,
    variantLatitude,
    modelVariantSeed,
    sisterModels,
    selection?.localitySpanTiles,
    selection?.localityBlendTiles,
  ) + (selection?.localVariantOffset ?? 0)) % Math.max(1, sisterModels);
  const variant = localVariant === 0 ? regionalVariant : {
    ...regionalVariant,
    key: `${regionalVariant.key}/local/${localVariant}`,
    seed: mixVariantSeed(regionalVariant.seed, localVariant),
    variantIndex: mixVariantSeed(regionalVariant.variantIndex, localVariant) >>> 0,
  };
  let bucket = buckets.get(variant.key);
  if (!bucket) {
    bucket = { variant, localVariant, matrices: [], colors: [] };
    buckets.set(variant.key, bucket);
  }
  bucket.matrices.push(matrix);
  if (color) bucket.colors.push(...color);
}

/** Derives a distinct but repeatable sister model inside one broad region. */
function mixVariantSeed(seed: number, variant: number): number {
  let mixed = (seed ^ Math.imul(variant, 0x9e3779b9)) >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d) >>> 0;
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b) >>> 0;
  return (mixed ^ (mixed >>> 16)) | 0;
}
