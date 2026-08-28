import {
  DirectionalLight,
  RawTexture,
  Scene,
  ShaderMaterial,
  ShadowGenerator,
  Texture,
  Vector2,
} from "@babylonjs/core";

export const VEGETATION_SHADOW_RECEIVER_BIAS = 0.00015;
/**
 * Fraction of direct sunlight a shadow leaves behind. Skylight bounced off the
 * surroundings fills a real shadow, so removing the sun outright reads darker
 * than any overcast sky. Shared with the built-in shadow generator so terrain,
 * buildings and vegetation sit in shadows of the same depth.
 */
export const SHADOW_DARKNESS = 0.3;
const fallbackShadowTextures = new WeakMap<Scene, RawTexture>();

function fallbackShadowTexture(scene: Scene): RawTexture {
  const cached = fallbackShadowTextures.get(scene);
  if (cached) return cached;
  const texture = RawTexture.CreateRGBATexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  texture.name = "fallbackVegetationShadowTexture";
  fallbackShadowTextures.set(scene, texture);
  return texture;
}

export const vegetationShadowVertexDeclaration = `
uniform mat4 vegetationShadowMatrix;
uniform float vegetationShadowAtInstanceRoot;
varying vec4 vVegetationShadowPosition;
`;

export const vegetationShadowFragmentDeclaration = `
#define DISABLE_UNIFORMITY_ANALYSIS
varying vec4 vVegetationShadowPosition;
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
  // The wrapped depth pass uses the same source fragment shader. Do not sample
  // the texture while that pass is writing it.
  #if SM_DIRECTIONINLIGHTDATA == 1
  return 1.0;
  #else
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
  #endif
}
`;

/** Supplies Babylon's regular depth shadow texture to custom vegetation shaders. */
export function bindVegetationShadowReceiver(material: ShaderMaterial, scene: Scene): void {
  material.setTexture("vegetationShadowSampler", fallbackShadowTexture(scene));
  material.setFloat("vegetationShadowEnabled", 0);
  material.setFloat("vegetationShadowDarkness", SHADOW_DARKNESS);
  material.setFloat("vegetationShadowAtInstanceRoot", 0);
  material.setFloat("vegetationShadowReverseDepth", scene.getEngine().useReverseDepthBuffer ? 1 : 0);
  const updateShadowUniforms = (): void => {
    const sun = scene.lights.find((light): light is DirectionalLight => (
      light instanceof DirectionalLight && light.name === "sunLight"
    ));
    const generator = sun?.getShadowGenerator();
    const camera = scene.activeCamera;
    if (!sun || !(generator instanceof ShadowGenerator) || !camera || !sun.isEnabled()) {
      material.setFloat("vegetationShadowEnabled", 0);
      return;
    }
    const shadowMap = generator.getShadowMapForRendering();
    if (!shadowMap) {
      material.setFloat("vegetationShadowEnabled", 0);
      return;
    }

    const size = shadowMap.getSize();
    material.setFloat("vegetationShadowEnabled", 1);
    material.setFloat(
      "vegetationShadowFloatTexture",
      isFloatShadowTexture(shadowMap.textureType) ? 1 : 0,
    );
    material.setMatrix("vegetationShadowMatrix", generator.getTransformMatrix());
    material.setVector2(
      "vegetationShadowTexelSize",
      new Vector2(1 / Math.max(1, size.width), 1 / Math.max(1, size.height)),
    );
    material.setVector2(
      "vegetationShadowDepthValues",
      new Vector2(
        sun.getDepthMinZ(camera),
        sun.getDepthMinZ(camera) + sun.getDepthMaxZ(camera),
      ),
    );
    material.setTexture("vegetationShadowSampler", shadowMap);
  };
  // ShaderMaterial's onBind observable fires after its stored values have
  // already been uploaded. Update before rendering so the current frame—not a
  // later material rebind—receives the shadow texture and transform.
  updateShadowUniforms();
  const observer = scene.onBeforeRenderObservable.add(updateShadowUniforms);
  material.onDisposeObservable.addOnce(() => {
    scene.onBeforeRenderObservable.remove(observer);
  });
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
