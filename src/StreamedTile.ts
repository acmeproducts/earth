import type { Mesh, TransformNode } from "@babylonjs/core";
import { OpenStreetMap } from "./OpenStreetMap";
import type { MapTile } from "./OpenStreetMap";
import type { RockFieldResult } from "./RockField";
import type { TerrainData } from "./TerrainData";
import type { RoadAndBuildingPlan } from "./RoadAndBuildingPlanner";
import { disposeTerrainMesh } from "./TerrainMaterial";
import { disposeTerrainLakeLayer } from "./TerrainLakeSurface";
import type { TerrainLakeLayer } from "./TerrainLakeSurface";
import type { VegetationFieldResult } from "./VegetationField";
import type { WorldTileId } from "./WorldGrid";
import type { WorldCover } from "./WorldCover";

export type VegetationFieldKind =
  | "treeField"
  | "saplingField"
  | "grassField"
  | "tallPlantField"
  | "wheatField"
  | "rockyBeachField"
  | "bushField"
  | "fernField";

export const VEGETATION_FIELD_KINDS: readonly VegetationFieldKind[] = [
  "treeField",
  "saplingField",
  "grassField",
  "tallPlantField",
  "wheatField",
  "rockyBeachField",
  "bushField",
  "fernField",
];

/** One streamed world tile and every scene resource it owns. */
export interface StreamedTile {
  id: WorldTileId;
  key: string;
  terrainData: TerrainData;
  landCover?: WorldCover;
  preCarvingElevations: Float32Array;
  mapTiles?: Promise<MapTile[]>;
  lakeContextTiles?: Promise<MapTile[]>;
  roadAndBuildingPlan: RoadAndBuildingPlan;
  terrain: Mesh;
  meshWidth: number;
  meshDepth: number;
  offsetX: number;
  offsetZ: number;
  nativeTerrain: boolean;
  treeField?: VegetationFieldResult;
  saplingField?: VegetationFieldResult;
  grassField?: VegetationFieldResult;
  tallPlantField?: VegetationFieldResult;
  wheatField?: VegetationFieldResult;
  rockyBeachField?: VegetationFieldResult;
  bushField?: VegetationFieldResult;
  fernField?: VegetationFieldResult;
  rockField?: RockFieldResult;
  mapFeatures?: TransformNode;
  barrierField?: VegetationFieldResult;
  lakeSurfaces?: TerrainLakeLayer;
  farBuildings?: TransformNode;
  farRoads?: TransformNode;
  farTreeField?: VegetationFieldResult;
  detailed: boolean;
  lastNeededMilliseconds: number;
  detailLastNeededMilliseconds: number;
  lodResolved: boolean;
}

/** Map features fade through per-mesh visibility; 1 restores the opaque path. */
export function setMapLayerFade(root: TransformNode, fade: number): void {
  if (root.isDisposed()) return;
  for (const mesh of root.getChildMeshes(false)) mesh.visibility = fade;
}

export function setFrozenMeshOffset(mesh: Mesh, x: number, z: number): void {
  const wasFrozen = mesh.isWorldMatrixFrozen;
  if (wasFrozen) mesh.unfreezeWorldMatrix();
  mesh.position.x = x;
  mesh.position.z = z;
  mesh.computeWorldMatrix(true);
  if (wasFrozen) mesh.freezeWorldMatrix();
}

export function setTransformNodeOffset(root: TransformNode, x: number, z: number): void {
  const frozenChildren = root.getChildMeshes(false).filter((mesh) => mesh.isWorldMatrixFrozen);
  frozenChildren.forEach((mesh) => mesh.unfreezeWorldMatrix());
  root.position.x = x;
  root.position.z = z;
  root.computeWorldMatrix(true);
  root.getChildMeshes(false).forEach((mesh) => mesh.computeWorldMatrix(true));
  frozenChildren.forEach((mesh) => mesh.freezeWorldMatrix());
}

export function disposeTileDetail(record: StreamedTile): void {
  for (const kind of VEGETATION_FIELD_KINDS) {
    record[kind]?.root.dispose(false, false);
    record[kind] = undefined;
  }
  record.rockField?.root.dispose(false, true);
  record.rockField = undefined;
  if (record.mapFeatures) OpenStreetMap.disposeLayer(record.mapFeatures);
  record.mapFeatures = undefined;
  record.barrierField = undefined;
  record.detailed = false;
}

export function disposeStreamedTile(record: StreamedTile): void {
  disposeTileDetail(record);
  record.farTreeField?.root.dispose(false, false);
  record.farTreeField = undefined;
  if (record.farBuildings) OpenStreetMap.disposeLayer(record.farBuildings);
  record.farBuildings = undefined;
  if (record.farRoads) OpenStreetMap.disposeLayer(record.farRoads);
  record.farRoads = undefined;
  if (record.lakeSurfaces) disposeTerrainLakeLayer(record.lakeSurfaces);
  record.lakeSurfaces = undefined;
  disposeTerrainMesh(record.terrain);
}
