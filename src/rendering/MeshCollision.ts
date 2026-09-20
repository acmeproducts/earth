import { Mesh, SubMesh } from "@babylonjs/core";

/** Share render geometry, but reject small index ranges before triangle tests. */
export function enableBatchedMeshCollisions(mesh: Mesh): Mesh {
  const indices = mesh.getTotalIndices();
  if (indices <= 1536 || !mesh.geometry) {
    mesh.checkCollisions = true;
    return mesh;
  }
  const collision = new Mesh(`${mesh.name} collision`, mesh.getScene());
  mesh.geometry.applyToMesh(collision);
  collision.parent = mesh;
  collision.isVisible = false;
  collision.isPickable = false;
  collision.checkCollisions = true;
  collision.releaseSubMeshes();
  for (let start = 0; start < indices; start += 1536) {
    SubMesh.CreateFromIndices(0, start, Math.min(1536, indices - start), collision);
  }
  mesh.checkCollisions = false;
  return collision;
}
