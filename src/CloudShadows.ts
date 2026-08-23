import {
  RawTexture,
  Scene,
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
  generateCloudShadowAtlasData,
} from "./CloudVolumeCapture";

const TERRAIN_CLOUD_SHADOW_COUNT = 4;

interface CloudShadowSceneState {
  readonly fallback: RawTexture;
  readonly lighting: Vector4;
  readonly placements: Vector4[];
  readonly metadata: Vector2[];
  readonly receivers: Set<CustomMaterial>;
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
      if (placement.z <= 0.0 || placement.w <= 0.0) return 0.0;
      vec2 localUV = (vCloudShadowWorldXZ - placement.xy) * placement.zw + vec2(0.5);
      vec2 edgeDistance = min(localUV, vec2(1.0) - localUV);
      if (min(edgeDistance.x, edgeDistance.y) <= 0.0) return 0.0;
      localUV.x = mix(localUV.x, 1.0 - localUV.x, metadata.y);
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
      return smoothstep(0.025, 0.72, density) * edgeFade;
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
    color.rgb *= 1.0 - cloudShadowCoverage * cloudShadowLighting.x * 0.52;
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

  const updateSelection = (): void => {
    const sunlight = smoothstep(0.04, 0.18, sunDirection.y);
    state.lighting.x = sunlight;
    if (sunlight <= 0 || fieldPlacements.length === 0) {
      clearSelectedPlacements(state);
      return;
    }

    const projectionY = Math.max(sunDirection.y, 0.08);
    const candidates = fieldPlacements.map((cloud) => {
      const projectionDistance = cloud.y / projectionY;
      const x = cloud.x + driftX - sunDirection.x * projectionDistance;
      const z = cloud.z + driftZ - sunDirection.z * projectionDistance;
      const outsideX = Math.max(
        Math.abs(cameraPosition.x - x) - cloud.width * 0.5,
        0,
      );
      const outsideZ = Math.max(
        Math.abs(cameraPosition.z - z) - cloud.depth * 0.5,
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
        1 / candidate.cloud.width,
        1 / candidate.cloud.depth,
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
