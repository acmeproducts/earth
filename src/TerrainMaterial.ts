import { Color3, Scene, StandardMaterial } from "@babylonjs/core";

/**
 * Owns the normal terrain appearance. Replace or extend this factory when
 * adding the project's terrain textures; debug layers are applied elsewhere.
 */
export function createTerrainMaterial(scene: Scene): StandardMaterial {
  const material = new StandardMaterial("terrainMaterial", scene);
  material.diffuseColor = new Color3(0.34, 0.42, 0.26);
  material.specularColor = new Color3(0.06, 0.06, 0.06);
  return material;
}
