import { Mesh, VertexData } from '@babylonjs/core';
import type { TransformNode } from '@babylonjs/core';
import { createShorelineGeometry } from './ShorelineGeometry';
import { clipShorelineToWater, type WaterBoundary } from './ShorelineWaterBoundary';
import {
  bindWaterMaterial, createWaterSurfaceMaterial, OCEAN_ELEVATION, prepareWaterSurfaceMesh,
} from './Water';
import type { WaterSurfaceKind } from './Water';

/** Tessellated water at the coast, using the same material as the broad surface. */
export async function attachShoreline(
  ground: Mesh,
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  metersPerUnit: number,
  yieldControl?: () => Promise<void>,
  options: {
    kind?: WaterSurfaceKind;
    elevation?: number;
    parent?: TransformNode;
    includesPoint?: (x: number, z: number) => boolean;
    waterBoundary?: WaterBoundary;
  } = {},
): Promise<Mesh | null> {
  const kind = options.kind ?? 'ocean';
  let geometry = await createShorelineGeometry(
    positions, indices, metersPerUnit, options.elevation ?? OCEAN_ELEVATION, yieldControl, options.includesPoint,
  );
  if (options.waterBoundary) geometry = clipShorelineToWater(geometry, options.waterBoundary);
  if (!geometry.indices.length) return null;
  const scene = ground.getScene();
  const mesh = new Mesh(`${ground.name} shoreline`, scene);
  const data = new VertexData();
  data.positions = geometry.positions;
  data.indices = geometry.indices;
  data.normals = new Float32Array(geometry.positions.length);
  for (let index = 1; index < data.normals.length; index += 3) data.normals[index] = 1;
  data.applyToMesh(mesh);
  prepareWaterSurfaceMesh(mesh);
  const shore = new Float32Array(geometry.depths.length * 2);
  for (let index = 0; index < geometry.depths.length; index++) {
    shore[index * 2] = geometry.depths[index];
    shore[index * 2 + 1] = 1;
  }
  mesh.setVerticesData('waterShore', shore, false, 2);
  mesh.parent = options.parent ?? ground;
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  const material = createWaterSurfaceMaterial(scene, { width: 1, height: 1, metersPerUnit, kind });
  bindWaterMaterial(mesh, material, metersPerUnit, kind);
  // Both crest displacement and foam fade into the broad surface before culling.
  mesh.addLODLevel(360 / metersPerUnit + mesh.getBoundingInfo().boundingSphere.radius, null);
  return mesh;
}
