import { Color3, Mesh, ShaderMaterial } from "@babylonjs/core";

export interface VegetationMaterialSettings {
  floats?: Readonly<Record<string, number>>;
  colors?: Readonly<Record<string, Color3>>;
}

/** Applies the same uniform settings to every shader-backed field renderer. */
export function configureVegetationMaterials(
  meshes: readonly Mesh[],
  settings: VegetationMaterialSettings,
): void {
  for (const mesh of meshes) {
    if (!(mesh.material instanceof ShaderMaterial)) continue;
    for (const [name, value] of Object.entries(settings.floats ?? {})) {
      mesh.material.setFloat(name, value);
    }
    for (const [name, value] of Object.entries(settings.colors ?? {})) {
      mesh.material.setColor3(name, value);
    }
  }
}
