import { fallbackWhiteTexture as fallbackShadowTexture } from "../rendering/FallbackTexture";
import {
  DirectionalLight,
  Engine,
  RenderTargetTexture,
  Scene,
  ShaderMaterial,
  ShadowGenerator,
  Vector2,
} from "@babylonjs/core";
import type { Matrix, Observer } from "@babylonjs/core";

export const VEGETATION_SHADOW_RECEIVER_BIAS = 0.00015;
/**
 * Fraction of direct sunlight a shadow leaves behind. Skylight bounced off the
 * surroundings fills a real shadow, so removing the sun outright reads darker
 * than any overcast sky. Shared with the built-in shadow generator so terrain,
 * buildings and vegetation sit in shadows of the same depth.
 */
export const SHADOW_DARKNESS = 0.3;

interface VegetationShadowReceiverState {
  materials: Set<ShaderMaterial>;
  update: (materials?: Iterable<ShaderMaterial>) => void;
  observer: Observer<Scene>;
}
const receiverStates = new WeakMap<Scene, VegetationShadowReceiverState>();

export const vegetationShadowVertexDeclaration = `
uniform mat4 vegetationShadowMatrix;
uniform float vegetationShadowAtInstanceRoot;
varying vec4 vVegetationShadowPosition;
`;

export const vegetationShadowFragmentDeclaration = `
#define DISABLE_UNIFORMITY_ANALYSIS
varying vec4 vVegetationShadowPosition;

#if SM_DIRECTIONINLIGHTDATA == 1
float vegetationShadowVisibility(void) {
  return 1.0;
}
#else
uniform sampler2D vegetationShadowSampler;
uniform vec2 vegetationShadowTexelSize;
uniform vec2 vegetationShadowDepthValues;
uniform float vegetationShadowEnabled;
uniform float vegetationShadowReverseDepth;
uniform float vegetationShadowDarkness;
uniform float vegetationShadowFloatTexture;

float unpackVegetationShadowDepth(vec4 packedDepth) {
  const vec4 bitShift = vec4(
    1.0 / (255.0 * 255.0 * 255.0),
    1.0 / (255.0 * 255.0),
    1.0 / 255.0,
    1.0
  );
  return dot(packedDepth, bitShift);
}

float vegetationShadowVisibility(void) {
  if (vegetationShadowEnabled < 0.5) return 1.0;
  vec3 clip = vVegetationShadowPosition.xyz
    / max(vVegetationShadowPosition.w, 0.00001);
  vec2 uv = clip.xy * 0.5 + vec2(0.5);
  if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return 1.0;

  float regularDepth = (
    vVegetationShadowPosition.z + vegetationShadowDepthValues.x
  ) / vegetationShadowDepthValues.y;
  float reversedDepth = (
    -vVegetationShadowPosition.z + vegetationShadowDepthValues.x
  ) / vegetationShadowDepthValues.y;
  float receiverDepth = mix(regularDepth, reversedDepth, vegetationShadowReverseDepth);
  if (receiverDepth <= 0.0 || receiverDepth >= 1.0) return 1.0;

  float visibility = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y)) * vegetationShadowTexelSize;
      vec4 shadowSample = texture2D(vegetationShadowSampler, uv + offset);
      float packedDepth = unpackVegetationShadowDepth(shadowSample);
      float casterDepth = mix(packedDepth, shadowSample.r, vegetationShadowFloatTexture);
      visibility += step(receiverDepth - ${VEGETATION_SHADOW_RECEIVER_BIAS}, casterDepth);
    }
  }
  visibility /= 9.0;
  return mix(vegetationShadowDarkness, 1.0, visibility);
}
#endif
`;

/** Supplies Babylon's regular depth shadow texture to custom vegetation shaders. */
export function bindVegetationShadowReceiver(material: ShaderMaterial, scene: Scene): void {
  if (receiverStates.get(scene)?.materials.has(material)) return;
  material.setTexture("vegetationShadowSampler", fallbackShadowTexture(scene));
  material.setFloat("vegetationShadowEnabled", 0);
  material.setFloat("vegetationShadowDarkness", SHADOW_DARKNESS);
  material.setFloat("vegetationShadowAtInstanceRoot", 0);
  material.setFloat("vegetationShadowReverseDepth", scene.getEngine().useReverseDepthBuffer ? 1 : 0);
  const state = shadowReceiverState(scene);
  state.materials.add(material);
  state.update([material]);
  material.onDisposeObservable.addOnce(() => {
    state.materials.delete(material);
    if (state.materials.size === 0) {
      scene.onBeforeRenderObservable.remove(state.observer);
      receiverStates.delete(scene);
    }
  });
}

/** All receivers use the same sun, camera, transform and texture each frame. */
function shadowReceiverState(scene: Scene): VegetationShadowReceiverState {
  const existing = receiverStates.get(scene);
  if (existing) return existing;
  const materials = new Set<ShaderMaterial>();
  const texelSize = Vector2.Zero();
  const depthValues = Vector2.Zero();
  let enabled: boolean | undefined;
  let previousMap: RenderTargetTexture | undefined;
  let previousMatrix: Matrix | undefined;
  let previousFloatTexture: number | undefined;
  const disable = (receivers?: Iterable<ShaderMaterial>): void => {
    const targets = enabled !== false ? materials : receivers;
    enabled = false;
    if (targets) for (const material of targets) material.setFloat("vegetationShadowEnabled", 0);
  };
  const updateShadowUniforms = (receivers?: Iterable<ShaderMaterial>): void => {
    const sun = scene.lights.find((light): light is DirectionalLight => (
      light instanceof DirectionalLight && light.name === "sunLight"
    ));
    const generator = sun?.getShadowGenerator();
    const camera = scene.activeCamera;
    if (!scene.shadowsEnabled || !sun || !sun.shadowEnabled ||
        !(generator instanceof ShadowGenerator) || !camera || !sun.isEnabled()) {
      disable(receivers);
      return;
    }
    const shadowMap = generator.getShadowMapForRendering();
    if (!shadowMap) {
      disable(receivers);
      return;
    }

    const size = shadowMap.getSize();
    const matrix = generator.getTransformMatrix();
    const floatTexture = isFloatShadowTexture(shadowMap.textureType) ? 1 : 0;
    const minDepth = sun.getDepthMinZ(camera);
    texelSize.set(1 / Math.max(1, size.width), 1 / Math.max(1, size.height));
    depthValues.set(minDepth, minDepth + sun.getDepthMaxZ(camera));
    // ShaderMaterial retains matrix/vector references and uploads their current
    // values on bind. Mutating the shared values above needs no repeated setters.
    const changed = enabled !== true || previousMap !== shadowMap ||
      previousMatrix !== matrix || previousFloatTexture !== floatTexture;
    const targets = changed ? materials : receivers;
    enabled = true;
    previousMap = shadowMap;
    previousMatrix = matrix;
    previousFloatTexture = floatTexture;
    if (!targets) return;
    for (const material of targets) {
      material.setFloat("vegetationShadowEnabled", 1);
      material.setFloat("vegetationShadowFloatTexture", floatTexture);
      material.setMatrix("vegetationShadowMatrix", matrix);
      material.setVector2("vegetationShadowTexelSize", texelSize);
      material.setVector2("vegetationShadowDepthValues", depthValues);
      material.setTexture("vegetationShadowSampler", shadowMap);
    }
  };
  // ShaderMaterial's onBind observable fires after its stored values have
  // already been uploaded. Update before rendering so the current frame—not a
  // later material rebind—receives the shadow texture and transform.
  const observer = scene.onBeforeRenderObservable.add(() => updateShadowUniforms());
  const state = { materials, update: updateShadowUniforms, observer };
  receiverStates.set(scene, state);
  return state;
}

/** Detaches the shadow target from every custom sampler before it is rendered. */
export function suspendVegetationShadowReceivers(
  scene: Scene,
  shadowMap: RenderTargetTexture,
): void {
  const fallback = fallbackShadowTexture(scene);
  for (const material of receiverStates.get(scene)?.materials ?? []) {
    material.setFloat("vegetationShadowEnabled", 0);
    material.setTexture("vegetationShadowSampler", fallback);
  }

  // ShaderMaterial setters only change the next effect bind. WebGL forbids a
  // render target from remaining on any sampler while its framebuffer is
  // active, and Babylon's private texture cache is not authoritative for all
  // direct bindings. Clear every unit here; shadow-depth effects rebind the
  // textures they need on their next effect bind.
  const engine = scene.getEngine();
  if (engine instanceof Engine && shadowMap.getInternalTexture()) {
    engine.unbindAllTextures();
  }
  scene.resetCachedMaterial();
}

/** Restores the live shadow target after its framebuffer has been detached. */
export function resumeVegetationShadowReceivers(scene: Scene): void {
  const state = receiverStates.get(scene);
  // Suspension deliberately replaced the sampler, even if the source map did
  // not change. Force all bindings back onto the live texture after unbinding.
  state?.update(state.materials);
}

/** Babylon packs depth into RGBA only for the unsigned-byte fallback. */
export function isFloatShadowTexture(textureType: number): boolean {
  return textureType !== 0;
}

/** CPU reference for the packed-depth expression used by the GLSL receiver. */
export function unpackVegetationShadowDepth(sample: readonly number[]): number {
  if (sample.length !== 4) throw new Error("Packed shadow samples require RGBA values.");
  return sample[0] / (255 ** 3) + sample[1] / (255 ** 2) + sample[2] / 255 + sample[3];
}

/** CPU reference of the shader comparison, used by the regression test. */
export function vegetationShadowVisibilityFromSamples(
  receiverDepth: number,
  samples: readonly (readonly number[])[],
  floatTexture: boolean,
  darkness: number,
): number {
  if (samples.length === 0) return 1;
  const visibleSamples = samples.reduce((visible, sample) => {
    const casterDepth = floatTexture ? sample[0] : unpackVegetationShadowDepth(sample);
    return visible + (
      casterDepth >= receiverDepth - VEGETATION_SHADOW_RECEIVER_BIAS ? 1 : 0
    );
  }, 0);
  const visibility = visibleSamples / samples.length;
  return darkness + (1 - darkness) * visibility;
}
