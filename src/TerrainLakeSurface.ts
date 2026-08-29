import {
  Mesh,
  PBRMaterial,
  PolygonMeshBuilder,
  StandardMaterial,
  TransformNode,
  Vector2,
  VertexBuffer,
} from "@babylonjs/core";
import type { BaseTexture, Scene } from "@babylonjs/core";
import earcut from "earcut";
import type { TerrainLakePolygon } from "./TerrainLakePolygons";
import {
  createWaterSurfaceMaterial,
  prepareWaterSurfaceMesh,
} from "./Water";

const terrainLakeMaterials = new WeakMap<Scene, PBRMaterial | StandardMaterial>();

export interface TerrainLakeSurfaceOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  worldOffsetX?: number;
  worldOffsetZ?: number;
  skyReflection?: BaseTexture | null;
}

export interface TerrainLakeLayer {
  root: TransformNode;
  meshes: Mesh[];
}

export const LAKE_SURFACE_CLEARANCE_METERS = 0.35;

/** Builds one flat water mesh for each prepared OSM lake polygon piece. */
export async function createTerrainLakeLayer(
  scene: Scene,
  polygons: readonly TerrainLakePolygon[],
  options: TerrainLakeSurfaceOptions,
  yieldControl?: () => Promise<void>,
): Promise<TerrainLakeLayer> {
  const root = new TransformNode("terrainLakes", scene);
  root.setEnabled(false);
  if (polygons.length === 0) return { root, meshes: [] };

  let material = terrainLakeMaterials.get(scene);
  if (!material) {
    material = createWaterSurfaceMaterial(scene, {
      name: "terrainLakeMaterial",
      kind: "lake",
      width: options.meshWidth,
      height: options.meshDepth,
      metersPerUnit: options.metersPerUnit,
      skyReflection: options.skyReflection,
    });
    terrainLakeMaterials.set(scene, material);
  }
  const meshes: Mesh[] = [];
  for (let index = 0; index < polygons.length; index++) {
    const polygon = polygons[index];
    const builder = new PolygonMeshBuilder(
      `terrainLake-${polygon.sourceId ?? index}`,
      polygon.outline.map(({ x, z }) => new Vector2(x, z)),
      scene,
      earcut,
    );
    for (const hole of polygon.holes) {
      builder.addHole(hole.map(({ x, z }) => new Vector2(x, z)));
    }
    const mesh = builder.build(false);
    mesh.position.y = (
      polygon.elevationMeters + LAKE_SURFACE_CLEARANCE_METERS
    ) / options.metersPerUnit;
    setWaterUvs(mesh, options);
    prepareWaterSurfaceMesh(mesh);
    mesh.material = material;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.parent = root;
    meshes.push(mesh);
    await yieldControl?.();
  }
  return { root, meshes };
}

/** Releases tile-owned lake geometry without disposing the shared sky map. */
export function disposeTerrainLakeLayer(layer: TerrainLakeLayer): void {
  for (const mesh of layer.meshes) mesh.material = null;
  layer.root.dispose(false, false);
}

function setWaterUvs(mesh: Mesh, options: TerrainLakeSurfaceOptions): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;
  const uvs = new Float32Array((positions.length / 3) * 2);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    uvs[vertex * 2] = (
      positions[vertex * 3] + (options.worldOffsetX ?? 0)
    ) / options.meshWidth;
    uvs[vertex * 2 + 1] = -(
      positions[vertex * 3 + 2] + (options.worldOffsetZ ?? 0)
    ) / options.meshDepth;
  }
  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
}
