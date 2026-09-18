import { Mesh, Scene, VertexData } from "@babylonjs/core";

export function createPlantMesh(
  scene: Scene,
  name: string,
  positions: number[],
  indices: number[],
  colors: number[],
  uvs?: Float32Array,
): Mesh {
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.colors = colors;
  if (uvs) data.uvs = uvs;
  const mesh = new Mesh(name, scene);
  data.applyToMesh(mesh);
  mesh.isPickable = false;
  mesh.useVertexColors = true;
  return mesh;
}

/** Connects paired edge vertices into a consistently wound leaf ribbon. */
export function appendBladeIndices(indices: number[], start: number, segments: number): void {
  for (let segment = 0; segment < segments; segment++) {
    const left = start + segment * 2;
    indices.push(left, left + 2, left + 1, left + 1, left + 2, left + 3);
  }
}
