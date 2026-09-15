import {
  Mesh,
  PolygonMeshBuilder,
  TransformNode,
  Vector2,
  VertexBuffer,
} from "@babylonjs/core";
import type { BaseTexture, Scene } from "@babylonjs/core";
import earcut from "earcut";
import type { TerrainLakePolygon } from "./TerrainLakePolygons";
import { distanceToRing, pointInRing } from '../core/PlanarGeometry';
import { attachShoreline } from '../water/Shoreline';
import {
  createWaterSurfaceMaterial,
  bindWaterMaterial,
  prepareWaterSurfaceMesh,
} from "../water/Water";

export interface TerrainLakeSurfaceOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  worldOffsetX?: number;
  worldOffsetZ?: number;
  skyReflection?: BaseTexture | null;
  /** Rendered bed for the same terrain-following shore waves as the ocean. */
  terrain?: Mesh;
}

export interface TerrainLakeLayer {
  root: TransformNode;
  meshes: Mesh[];
}

export const LAKE_SURFACE_CLEARANCE_METERS = 0.35;

/** The common water shader moves each prepared OSM lake polygon piece. */
export async function createTerrainLakeLayer(
  scene: Scene,
  polygons: readonly TerrainLakePolygon[],
  options: TerrainLakeSurfaceOptions,
  yieldControl?: () => Promise<void>,
): Promise<TerrainLakeLayer> {
  const root = new TransformNode("terrainLakes", scene);
  root.setEnabled(false);
  if (polygons.length === 0) return { root, meshes: [] };

  const material = createWaterSurfaceMaterial(scene, {
    name: "terrainLakeMaterial",
    kind: "lake",
    width: options.meshWidth,
    height: options.meshDepth,
    metersPerUnit: options.metersPerUnit,
    skyReflection: options.skyReflection,
  });
  const bedPositions = options.terrain?.getVerticesData(VertexBuffer.PositionKind);
  const bedIndices = options.terrain?.getIndices();
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
    bindWaterMaterial(mesh, material, options.metersPerUnit, 'lake');
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    mesh.parent = root;
    meshes.push(mesh);
    if (options.terrain && bedPositions && bedIndices) {
      const padding = 24 / options.metersPerUnit;
      const minimumX = Math.min(...polygon.outline.map(point => point.x)) - padding;
      const maximumX = Math.max(...polygon.outline.map(point => point.x)) + padding;
      const minimumZ = Math.min(...polygon.outline.map(point => point.z)) - padding;
      const maximumZ = Math.max(...polygon.outline.map(point => point.z)) + padding;
      const shore = await attachShoreline(options.terrain, bedPositions, bedIndices,
        options.metersPerUnit, yieldControl, {
          kind: 'lake', elevation: mesh.position.y, parent: root,
          waterBoundary: polygon,
          // Restrict equal-height contours to this lake and its bank. Holes
          // contribute their own shores, while distant same-height land does not.
          includesPoint: (x, z) => {
            if (x < minimumX || x > maximumX || z < minimumZ || z > maximumZ) return false;
            const point = { x, z };
            if (pointInRing(point, polygon.outline)) {
              const hole = polygon.holes.find(ring => pointInRing(point, ring));
              return !hole || distanceToRing(point, hole) <= padding;
            }
            return distanceToRing(point, polygon.outline) <= padding;
          },
        });
      if (shore) meshes.push(shore);
    }
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
