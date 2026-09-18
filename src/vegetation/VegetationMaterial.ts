import { Color3, Mesh, ShaderMaterial } from "@babylonjs/core";
import { vegetationDistanceFadeRange } from "./DistanceDropout";
import type { VegetationFieldResult } from "./VegetationField";

/** Keeps model and impostor distance fades aligned with the streaming circle. */
export function setVegetationFieldDetailDistance(
  field: VegetationFieldResult,
  tileWidth: number,
  detailTilesAcross: number,
): void {
  const fade = vegetationDistanceFadeRange(tileWidth, detailTilesAcross);
  configureVegetationMaterials([...field.impostorMeshes, ...field.modelMeshes], {
    floats: { distanceFadeNear: fade.near, distanceFadeFar: fade.far },
  });
}

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
