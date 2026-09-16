import { Mesh, SubMesh } from '@babylonjs/core';

/** Row-ordered terrain indices make small strips an inexpensive broad phase.
 * Share GPU geometry with the visible mesh but keep collision submeshes out of
 * rendering, so finer collision bounds do not multiply terrain draw calls.
 */
export function enableTerrainCollisions(terrain: Mesh): Mesh {
  const indices = terrain.getTotalIndices();
  if (indices <= 1536 || !terrain.geometry) {
    terrain.checkCollisions = true;
    return terrain;
  }
  const collision = new Mesh(`${terrain.name} collision`, terrain.getScene());
  terrain.geometry.applyToMesh(collision);
  collision.parent = terrain;
  collision.isVisible = false;
  collision.isPickable = false;
  collision.checkCollisions = true;
  collision.releaseSubMeshes();
  for (let start = 0; start < indices; start += 1536) {
    SubMesh.CreateFromIndices(0, start, Math.min(1536, indices - start), collision);
  }
  terrain.checkCollisions = false;
  return collision;
}
