import { Effect, Scene, ShaderMaterial, Vector2, Vector3, Vector4 } from "@babylonjs/core";
import { CustomMaterial } from "@babylonjs/materials/custom/customMaterial.js";
import { cloudCoverageShader, cloudFieldForScene } from "./CloudField";
import { fallbackWhiteTexture } from "../rendering/FallbackTexture";

export const CLOUD_SHADOW_UNIFORMS = ["cloudField", "cloudOffset", "cloudSun"];
export const cloudShadowVertexDeclaration = "varying vec2 vCloudShadowWorldXZ;";
const shadowSampling = `
${cloudCoverageShader}
uniform vec3 cloudSun;
float cloudShadowVisibility(vec2 worldXZ) {
  if (cloudField.y <= 0.0 || cloudField.w <= 0.0) return 1.0;
  vec2 cloudXZ = worldXZ + cloudSun.xz * (cloudField.z / max(cloudSun.y, 0.07));
  return 1.0 - cloudCoverage(cloudXZ) * cloudField.w * 0.22;
}`;
export const cloudShadowFragmentDeclaration = `
${cloudShadowVertexDeclaration}
#if SM_DIRECTIONINLIGHTDATA == 1
float vegetationCloudShadowVisibility(void) { return 1.0; }
#else
${shadowSampling}
float vegetationCloudShadowVisibility(void) { return cloudShadowVisibility(vCloudShadowWorldXZ); }
#endif`;

const disabled = Vector4.Zero();
const zero = Vector2.Zero();
const up = Vector3.Up();

/** Read the current field on every bind, including receivers created before clouds. */
function bindField(effect: Effect, scene: Scene): void {
  const field = cloudFieldForScene(scene);
  effect.setTexture("cloudPattern", field?.texture ?? fallbackWhiteTexture(scene));
  effect.setVector4("cloudField", field?.parameters ?? disabled);
  effect.setVector2("cloudOffset", field?.offset ?? zero);
  effect.setVector3("cloudSun", field?.sun ?? up);
}

export function bindCloudShadowReceiver(material: ShaderMaterial, scene: Scene): void {
  material.onBindObservable.add(() => {
    const effect = material.getEffect();
    if (effect) bindField(effect, scene);
  });
}

export function createCloudShadowTerrainMaterial(name: string, scene: Scene): CustomMaterial | undefined {
  if (!cloudFieldForScene(scene)) return undefined;
  const material = new CustomMaterial(name, scene);
  material.AddUniform("cloudPattern", "sampler2D", undefined);
  material.AddUniform("cloudField", "vec4", undefined);
  material.AddUniform("cloudOffset", "vec2", undefined);
  material.AddUniform("cloudSun", "vec3", undefined);
  material.Vertex_Definitions(cloudShadowVertexDeclaration);
  material.Vertex_After_WorldPosComputed("vCloudShadowWorldXZ = worldPos.xz;");
  // CustomMaterial declares added uniforms itself.
  material.Fragment_Definitions(cloudShadowVertexDeclaration + shadowSampling.replace(/uniform [^;]+;/g, ""));
  material.Fragment_Before_Fog("color.rgb *= cloudShadowVisibility(vCloudShadowWorldXZ);");
  material.onBindObservable.add(() => {
    const effect = material.getEffect();
    if (effect) bindField(effect, scene);
  });
  return material;
}
