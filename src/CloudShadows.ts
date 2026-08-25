import {
  RawTexture,
  Scene,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  Vector4,
} from "@babylonjs/core";
import { CustomMaterial } from "@babylonjs/materials/custom/customMaterial.js";
import type { CloudPlacement } from "./CloudDistribution";
import {
  CLOUD_ATLAS_COLUMNS,
  CLOUD_SHADOW_TEXTURE_SIZE,
  CLOUD_TEXTURE_GUTTER,
  cloudShadowFootprintScale,
  generateCloudShadowAtlasData,
} from "./CloudVolumeCapture";

const TERRAIN_CLOUD_SHADOW_COUNT = 4;
const CLOUD_SHADOW_DIRECTION_REFRESH_RADIANS = 3 * Math.PI / 180;
// Even an opaque cloud leaves diffuse skylight, so its contribution alone may
// remove at most 22% of the receiver's light.
const CLOUD_SHADOW_DARKNESS = 0.22;
// Low-angle sunlight contributes less contrast than the ambient sky, so cloud
// shadows should build gradually through dawn and fall away before sunset.
const CLOUD_SHADOW_FADE_START = Math.sin(4 * Math.PI / 180);
const CLOUD_SHADOW_FULL_STRENGTH = Math.sin(20 * Math.PI / 180);

interface CloudShadowSceneState {
  readonly fallback: RawTexture;
  readonly lighting: Vector4;
  readonly placements: Vector4[];
  readonly metadata: Vector2[];
  readonly receivers: Set<CustomMaterial>;
  readonly vegetationReceivers: Set<ShaderMaterial>;
  texture: Texture;
  atlasDimensions: Vector2;
  atlasTileStride: Vector2;
  disposeProjector?: () => void;
}

export interface CloudShadowProjector {
  setDrift(x: number, z: number): void;
  update(cameraPosition: Vector3, sunDirection: Vector3): void;
  upload(placements: readonly CloudPlacement[]): void;
  dispose(): void;
}

const sceneStates = new WeakMap<Scene, CloudShadowSceneState>();

export const cloudShadowVertexDeclaration = `
varying vec2 vCloudShadowWorldXZ;
`;

export const cloudShadowFragmentDeclaration = `
varying vec2 vCloudShadowWorldXZ;
uniform sampler2D cloudShadowAtlas;
uniform vec4 cloudShadowLighting;
uniform vec2 cloudShadowAtlasDimensions;
uniform vec2 cloudShadowAtlasTileStride;
uniform vec4 cloudShadowPlacement0;
uniform vec4 cloudShadowPlacement1;
uniform vec4 cloudShadowPlacement2;
uniform vec4 cloudShadowPlacement3;
uniform vec2 cloudShadowMetadata0;
uniform vec2 cloudShadowMetadata1;
uniform vec2 cloudShadowMetadata2;
uniform vec2 cloudShadowMetadata3;

float sampleVegetationCloudShadow(vec4 placement, vec2 metadata) {
  vec2 localUV = (vCloudShadowWorldXZ - placement.xy) * placement.zw + vec2(0.5);
  vec2 edgeDistance = min(localUV, vec2(1.0) - localUV);
  float placementEnabled = step(0.000001, min(placement.z, placement.w));
  localUV.x = mix(localUV.x, 1.0 - localUV.x, metadata.y);
  localUV = clamp(localUV, vec2(0.0), vec2(1.0));
  float variant = floor(metadata.x + 0.5);
  vec2 cell = vec2(
    mod(variant, ${CLOUD_ATLAS_COLUMNS}.0),
    floor(variant / ${CLOUD_ATLAS_COLUMNS}.0)
  );
  vec2 atlasPixel = cell * cloudShadowAtlasTileStride
    + vec2(${CLOUD_TEXTURE_GUTTER}.0)
    + localUV * vec2(${CLOUD_SHADOW_TEXTURE_SIZE - 1}.0)
    + vec2(0.5);
  float density = texture2D(
    cloudShadowAtlas,
    atlasPixel / cloudShadowAtlasDimensions
  ).r;
  float edgeFade = smoothstep(0.0, 0.04, min(edgeDistance.x, edgeDistance.y));
  return smoothstep(0.025, 0.72, density) * edgeFade * placementEnabled;
}

float vegetationCloudShadowVisibility(void) {
  #if SM_DIRECTIONINLIGHTDATA == 1
  return 1.0;
  #else
  float coverage = 1.0;
  coverage *= 1.0 - sampleVegetationCloudShadow(
    cloudShadowPlacement0,
    cloudShadowMetadata0
  );
  coverage *= 1.0 - sampleVegetationCloudShadow(
    cloudShadowPlacement1,
    cloudShadowMetadata1
  );
  coverage *= 1.0 - sampleVegetationCloudShadow(
    cloudShadowPlacement2,
    cloudShadowMetadata2
  );
  coverage *= 1.0 - sampleVegetationCloudShadow(
    cloudShadowPlacement3,
    cloudShadowMetadata3
  );
  coverage = 1.0 - coverage;
  return 1.0 - coverage * cloudShadowLighting.x * ${CLOUD_SHADOW_DARKNESS};
  #endif
}
`;

export const CLOUD_SHADOW_UNIFORMS = [
  "cloudShadowLighting",
  "cloudShadowAtlasDimensions",
  "cloudShadowAtlasTileStride",
  "cloudShadowPlacement0",
  "cloudShadowPlacement1",
  "cloudShadowPlacement2",
  "cloudShadowPlacement3",
  "cloudShadowMetadata0",
  "cloudShadowMetadata1",
  "cloudShadowMetadata2",
  "cloudShadowMetadata3",
] as const;

/** Supplies the shared projected cloud field to a custom vegetation shader. */
export function bindCloudShadowReceiver(material: ShaderMaterial, scene: Scene): void {
  const state = cloudShadowState(scene);
  material.setTexture("cloudShadowAtlas", state.texture);
  material.setVector4("cloudShadowLighting", state.lighting);
  material.setVector2("cloudShadowAtlasDimensions", state.atlasDimensions);
  material.setVector2("cloudShadowAtlasTileStride", state.atlasTileStride);
  for (let index = 0; index < TERRAIN_CLOUD_SHADOW_COUNT; index++) {
    material.setVector4(`cloudShadowPlacement${index}`, state.placements[index]);
    material.setVector2(`cloudShadowMetadata${index}`, state.metadata[index]);
  }
  state.vegetationReceivers.add(material);
  material.onDisposeObservable.addOnce(() => state.vegetationReceivers.delete(material));
}

/** Adds the nearest sun-projected cloud impostors to a shared terrain material. */
export function createCloudShadowTerrainMaterial(
  name: string,
  scene: Scene,
): CustomMaterial | undefined {
  const state = sceneStates.get(scene);
  if (!state) return undefined;

  const material = new CustomMaterial(name, scene);
  material.AddUniform("cloudShadowAtlas", "sampler2D", state.texture);
  material.AddUniform("cloudShadowLighting", "vec4", state.lighting);
  material.AddUniform("cloudShadowAtlasDimensions", "vec2", state.atlasDimensions);
  material.AddUniform("cloudShadowAtlasTileStride", "vec2", state.atlasTileStride);
  for (let index = 0; index < TERRAIN_CLOUD_SHADOW_COUNT; index++) {
    material.AddUniform(
      `cloudShadowPlacement${index}`,
      "vec4",
      state.placements[index],
    );
    material.AddUniform(
      `cloudShadowMetadata${index}`,
      "vec2",
      state.metadata[index],
    );
  }
  material.Vertex_Definitions("varying vec2 vCloudShadowWorldXZ;");
  material.Vertex_After_WorldPosComputed(`
    vCloudShadowWorldXZ = worldPos.xz;
  `);
  material.Fragment_Definitions(`
    varying vec2 vCloudShadowWorldXZ;

    float sampleProjectedCloudShadow(vec4 placement, vec2 metadata) {
      vec2 localUV = (vCloudShadowWorldXZ - placement.xy) * placement.zw + vec2(0.5);
      vec2 edgeDistance = min(localUV, vec2(1.0) - localUV);
      float placementEnabled = step(0.000001, min(placement.z, placement.w));
      localUV.x = mix(localUV.x, 1.0 - localUV.x, metadata.y);
      localUV = clamp(localUV, vec2(0.0), vec2(1.0));
      float variant = floor(metadata.x + 0.5);
      vec2 cell = vec2(
        mod(variant, ${CLOUD_ATLAS_COLUMNS}.0),
        floor(variant / ${CLOUD_ATLAS_COLUMNS}.0)
      );
      vec2 atlasPixel = cell * cloudShadowAtlasTileStride
        + vec2(${CLOUD_TEXTURE_GUTTER}.0)
        + localUV * vec2(${CLOUD_SHADOW_TEXTURE_SIZE - 1}.0)
        + vec2(0.5);
      float density = texture2D(
        cloudShadowAtlas,
        atlasPixel / cloudShadowAtlasDimensions
      ).r;
      float edgeFade = smoothstep(0.0, 0.04, min(edgeDistance.x, edgeDistance.y));
      return smoothstep(0.025, 0.72, density) * edgeFade * placementEnabled;
    }
  `);
  material.Fragment_Before_Fog(`
    float cloudShadowCoverage = 1.0;
    cloudShadowCoverage *= 1.0 - sampleProjectedCloudShadow(
      cloudShadowPlacement0,
      cloudShadowMetadata0
    );
    cloudShadowCoverage *= 1.0 - sampleProjectedCloudShadow(
      cloudShadowPlacement1,
      cloudShadowMetadata1
    );
    cloudShadowCoverage *= 1.0 - sampleProjectedCloudShadow(
      cloudShadowPlacement2,
      cloudShadowMetadata2
    );
    cloudShadowCoverage *= 1.0 - sampleProjectedCloudShadow(
      cloudShadowPlacement3,
      cloudShadowMetadata3
    );
    cloudShadowCoverage = 1.0 - cloudShadowCoverage;
    color.rgb *= 1.0
      - cloudShadowCoverage * cloudShadowLighting.x * ${CLOUD_SHADOW_DARKNESS};
  `);
  state.receivers.add(material);
  material.onDisposeObservable.add(() => state.receivers.delete(material));
  return material;
}

/** Keeps the four most relevant cloud footprints in terrain shader uniforms. */
export function createCloudShadowProjector(
  scene: Scene,
  _metersPerUnit: number,
): CloudShadowProjector {
  const state = cloudShadowState(scene);
  state.disposeProjector?.();

  const atlas = createShadowAtlas(scene);
  state.atlasDimensions.copyFrom(atlas.dimensions);
  state.atlasTileStride.copyFrom(atlas.tileStride);
  setReceiverTexture(state, atlas.texture);

  let disposed = false;
  let fieldPlacements: readonly CloudPlacement[] = [];
  let driftX = 0;
  let driftZ = 0;
  const cameraPosition = Vector3.Zero();
  const sunDirection = Vector3.Up();
  const atlasSunDirection = Vector3.Up();
  let atlasFootprintScale = cloudShadowFootprintScale(atlasSunDirection);

  const updateSelection = (): void => {
    const sunlight = smoothstep(
      CLOUD_SHADOW_FADE_START,
      CLOUD_SHADOW_FULL_STRENGTH,
      sunDirection.y,
    );
    state.lighting.x = sunlight;
    if (sunlight <= 0 || fieldPlacements.length === 0) {
      clearSelectedPlacements(state);
      return;
    }

    const directionDot = Vector3.Dot(sunDirection, atlasSunDirection);
    if (directionDot < Math.cos(CLOUD_SHADOW_DIRECTION_REFRESH_RADIANS)) {
      atlas.texture.update(generateCloudShadowAtlasData(sunDirection).pixels);
      atlasSunDirection.copyFrom(sunDirection);
      atlasFootprintScale = cloudShadowFootprintScale(atlasSunDirection);
    }

    const projectionY = Math.max(sunDirection.y, 0.08);
    const candidates = fieldPlacements.map((cloud) => {
      const projectionDistance = cloud.y / projectionY;
      const x = cloud.x + driftX - sunDirection.x * projectionDistance;
      const z = cloud.z + driftZ - sunDirection.z * projectionDistance;
      const outsideX = Math.max(
        Math.abs(cameraPosition.x - x) - cloud.width * atlasFootprintScale.x * 0.5,
        0,
      );
      const outsideZ = Math.max(
        Math.abs(cameraPosition.z - z) - cloud.depth * atlasFootprintScale.z * 0.5,
        0,
      );
      return {
        cloud,
        x,
        z,
        distanceSquared: outsideX * outsideX + outsideZ * outsideZ,
      };
    });
    candidates.sort((first, second) => first.distanceSquared - second.distanceSquared);

    for (let index = 0; index < TERRAIN_CLOUD_SHADOW_COUNT; index++) {
      const candidate = candidates[index];
      if (!candidate) {
        state.placements[index].set(0, 0, 0, 0);
        state.metadata[index].set(0, 0);
        continue;
      }
      state.placements[index].set(
        candidate.x,
        candidate.z,
        1 / (candidate.cloud.width * atlasFootprintScale.x),
        1 / (candidate.cloud.depth * atlasFootprintScale.z),
      );
      state.metadata[index].set(
        candidate.cloud.variant,
        candidate.cloud.mirrored ? 1 : 0,
      );
    }
  };

  const disposeProjector = (): void => {
    if (disposed) return;
    disposed = true;
    clearSelectedPlacements(state);
    state.lighting.x = 0;
    setReceiverTexture(state, state.fallback);
    atlas.texture.dispose();
    if (state.disposeProjector === disposeProjector) state.disposeProjector = undefined;
  };
  state.disposeProjector = disposeProjector;

  return {
    setDrift(x: number, z: number) {
      driftX = x;
      driftZ = z;
      updateSelection();
    },
    update(nextCameraPosition: Vector3, nextSunDirection: Vector3) {
      cameraPosition.copyFrom(nextCameraPosition);
      sunDirection.copyFrom(nextSunDirection);
      updateSelection();
    },
    upload(placements: readonly CloudPlacement[]) {
      fieldPlacements = placements;
      updateSelection();
    },
    dispose: disposeProjector,
  };
}

function cloudShadowState(scene: Scene): CloudShadowSceneState {
  const existing = sceneStates.get(scene);
  if (existing) return existing;
  const fallback = RawTexture.CreateRGBATexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  fallback.name = "fallbackCloudShadowTexture";
  const state: CloudShadowSceneState = {
    fallback,
    lighting: Vector4.Zero(),
    placements: Array.from(
      { length: TERRAIN_CLOUD_SHADOW_COUNT },
      () => Vector4.Zero(),
    ),
    metadata: Array.from(
      { length: TERRAIN_CLOUD_SHADOW_COUNT },
      () => Vector2.Zero(),
    ),
    receivers: new Set(),
    vegetationReceivers: new Set(),
    texture: fallback,
    atlasDimensions: Vector2.One(),
    atlasTileStride: Vector2.One(),
  };
  sceneStates.set(scene, state);
  return state;
}

function clearSelectedPlacements(state: CloudShadowSceneState): void {
  for (let index = 0; index < TERRAIN_CLOUD_SHADOW_COUNT; index++) {
    state.placements[index].set(0, 0, 0, 0);
    state.metadata[index].set(0, 0);
  }
}

function setReceiverTexture(state: CloudShadowSceneState, texture: Texture): void {
  state.texture = texture;
  for (const material of state.receivers) {
    material._newSamplerInstances["sampler2D-cloudShadowAtlas"] = texture;
  }
  for (const material of state.vegetationReceivers) {
    material.setTexture("cloudShadowAtlas", texture);
  }
}

function createShadowAtlas(scene: Scene): {
  texture: RawTexture;
  dimensions: Vector2;
  tileStride: Vector2;
} {
  const atlas = generateCloudShadowAtlasData();
  const texture = RawTexture.CreateRGBATexture(
    atlas.pixels,
    atlas.width,
    atlas.height,
    scene,
    true,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  texture.name = "cloudShadowDensityAtlas";
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return {
    texture,
    dimensions: new Vector2(atlas.width, atlas.height),
    tileStride: new Vector2(atlas.tileStrideX, atlas.tileStrideY),
  };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return amount * amount * (3 - 2 * amount);
}
