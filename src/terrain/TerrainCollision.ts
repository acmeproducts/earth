import type { Mesh } from '@babylonjs/core';
import { enableBatchedMeshCollisions } from '../rendering/MeshCollision';

/** Row-ordered terrain indices make small strips an inexpensive broad phase.
 * Share GPU geometry with the visible mesh but keep collision submeshes out of
 * rendering, so finer collision bounds do not multiply terrain draw calls.
 */
export function enableTerrainCollisions(terrain: Mesh): Mesh {
  return enableBatchedMeshCollisions(terrain);
}
