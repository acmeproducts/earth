import {
  Color3,
  Constants,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  RawTexture,
  Scene,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
} from "@babylonjs/core";
import { SolarLighting } from "./SolarLighting";
import type { SolarLightingSnapshot } from "./SolarLighting";
import {
  CLOUD_CELL_SIZE_METERS,
  cloudPlacementsAround,
  cloudWeatherForSeed,
} from "./CloudDistribution";
import type { CloudPlacement } from "./CloudDistribution";
import {
  CLOUD_ATLAS_COLUMNS,
  CLOUD_TEXTURE_GUTTER,
  CLOUD_TEXTURE_HEIGHT,
  CLOUD_TEXTURE_WIDTH,
  generateCloudDensityAtlasData,
} from "./CloudVolumeCapture";
import { copyPrevailingWindDirectionTo } from "./Wind";

const CLOUD_NEAR_FADE_START_METERS = 2_500;
const CLOUD_NEAR_FADE_END_METERS = 3_800;
const CLOUD_FAR_FADE_START_METERS = 12_000;
const CLOUD_FAR_FADE_END_METERS = 18_000;
const CLOUD_DRIFT_METERS_PER_SECOND = 20;

export interface CloudLayer {
  readonly mesh: Mesh;
  update(cameraPosition: Vector3): void;
  dispose(): void;
}

export interface CloudLayerOptions {
  metersPerUnit: number;
  weatherSeed: number;
}

const cloudVertexShader = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
#ifdef THIN_INSTANCES
attribute float cloudVariant;
attribute float cloudMirror;
#endif
uniform mat4 viewProjection;
uniform vec3 cameraPosition;
#include<instancesDeclaration>
varying vec2 vUV;
varying vec3 vViewDirection;
varying float vCloudVariant;

void main(void) {
  #include<instancesVertex>
  vec3 center = finalWorld[3].xyz;
  vec3 toCamera = normalize(cameraPosition - center);
  vec3 billboardRight = cross(toCamera, vec3(0.0, 1.0, 0.0));
  float rightLength = length(billboardRight);
  billboardRight = rightLength > 0.0001
    ? billboardRight / rightLength
    : vec3(1.0, 0.0, 0.0);
  vec3 billboardUp = normalize(cross(billboardRight, toCamera));
  float width = length(finalWorld[0].xyz);
  float height = length(finalWorld[1].xyz);
  vec3 worldPosition = center
    + billboardRight * position.x * width
    + billboardUp * position.y * height;

  vViewDirection = cameraPosition - center;
  #ifdef THIN_INSTANCES
  vUV = vec2(mix(uv.x, 1.0 - uv.x, cloudMirror), uv.y);
  vCloudVariant = cloudVariant;
  #else
  vUV = uv;
  vCloudVariant = 0.0;
  #endif
  gl_Position = viewProjection * vec4(worldPosition, 1.0);
}`;

const cloudFragmentShader = `
precision highp float;
varying vec2 vUV;
varying vec3 vViewDirection;
varying float vCloudVariant;
uniform sampler2D cloudAtlas;
uniform vec2 atlasDimensions;
uniform vec2 atlasTileStride;
uniform vec2 atlasTileSize;
uniform float atlasGutter;
uniform float atlasColumns;
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform vec3 skyColor;
uniform vec3 groundColor;
uniform vec3 fogColor;
uniform float nearFadeStart;
uniform float nearFadeEnd;
uniform float farFadeStart;
uniform float farFadeEnd;

void main(void) {
  float variant = floor(vCloudVariant + 0.5);
  vec2 cell = vec2(mod(variant, atlasColumns), floor(variant / atlasColumns));
  vec2 atlasPixel = cell * atlasTileStride
    + vec2(atlasGutter)
    + vUV * (atlasTileSize - vec2(1.0))
    + vec2(0.5);
  vec2 density = texture2D(cloudAtlas, atlasPixel / atlasDimensions).rg;

  float distanceToCamera = length(vViewDirection);
  float nearFade = smoothstep(nearFadeStart, nearFadeEnd, distanceToCamera);
  float farFade = 1.0 - smoothstep(farFadeStart, farFadeEnd, distanceToCamera);
  float coverage = density.r * nearFade * farFade;

  float core = smoothstep(0.16, 0.86, max(density.r, density.g));
  vec3 toCamera = normalize(vViewDirection);
  float backLight = pow(max(dot(-toCamera, sunDirection), 0.0), 7.0);
  float silverLining = backLight * (1.0 - smoothstep(0.18, 0.72, density.r));
  float sunAboveHorizon = max(sunDirection.y, 0.0);
  vec3 ambient = mix(groundColor, skyColor, 0.62);
  vec3 lighting = ambient * mix(1.08, 0.68, core)
    + sunColor * (0.10 + 0.22 * sunAboveHorizon + 0.72 * silverLining);
  vec3 cloudColor = clamp(lighting, vec3(0.015), vec3(1.3));
  float highAltitudeHaze = smoothstep(farFadeStart, farFadeEnd, distanceToCamera) * 0.55;
  gl_FragColor = vec4(mix(cloudColor, fogColor, highAltitudeHaze), coverage);
}`;

/**
 * Creates distant, smoothly blended cloud impostors around the active camera.
 * Their coverage is captured from procedural 3D density and rendered in one
 * thin-instanced draw.
 */
export function createCloudLayer(
  scene: Scene,
  lighting: SolarLighting,
  options: CloudLayerOptions,
): CloudLayer | undefined {
  const { metersPerUnit, weatherSeed } = options;
  if (cloudWeatherForSeed(weatherSeed).occupancy === 0) return undefined;
  const atlas = createCloudDensityAtlas(scene);
  const mesh = MeshBuilder.CreatePlane("cloudImpostors", { size: 1 }, scene);
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.alwaysSelectAsActiveMesh = true;

  const material = new ShaderMaterial(
    "cloudImpostorMaterial",
    scene,
    { vertexSource: cloudVertexShader, fragmentSource: cloudFragmentShader },
    {
      attributes: ["position", "uv", "cloudVariant", "cloudMirror"],
      uniforms: [
        "world",
        "viewProjection",
        "cameraPosition",
        "atlasDimensions",
        "atlasTileStride",
        "atlasTileSize",
        "atlasGutter",
        "atlasColumns",
        "sunDirection",
        "sunColor",
        "skyColor",
        "groundColor",
        "fogColor",
        "nearFadeStart",
        "nearFadeEnd",
        "farFadeStart",
        "farFadeEnd",
      ],
      samplers: ["cloudAtlas"],
      needAlphaBlending: true,
    },
  );
  material.backFaceCulling = false;
  material.fogEnabled = false;
  material.alphaMode = Constants.ALPHA_COMBINE;
  material.setTexture("cloudAtlas", atlas.texture);
  material.setVector2("atlasDimensions", atlas.dimensions);
  material.setVector2("atlasTileStride", atlas.tileStride);
  material.setVector2("atlasTileSize", atlas.tileSize);
  material.setFloat("atlasGutter", CLOUD_TEXTURE_GUTTER);
  material.setFloat("atlasColumns", CLOUD_ATLAS_COLUMNS);
  material.setFloat("nearFadeStart", CLOUD_NEAR_FADE_START_METERS / metersPerUnit);
  material.setFloat("nearFadeEnd", CLOUD_NEAR_FADE_END_METERS / metersPerUnit);
  material.setFloat("farFadeStart", CLOUD_FAR_FADE_START_METERS / metersPerUnit);
  material.setFloat("farFadeEnd", CLOUD_FAR_FADE_END_METERS / metersPerUnit);
  mesh.material = material;

  const lightingSnapshot: SolarLightingSnapshot = {
    sunDirection: Vector3.Up(),
    sunColor: Color3.Black(),
    skyColor: Color3.Black(),
    groundColor: Color3.Black(),
  };
  material.onBindObservable.add(() => {
    const camera = scene.activeCamera;
    if (!camera) return;
    lighting.copyLightingTo(lightingSnapshot);
    material.setVector3("cameraPosition", camera.globalPosition);
    material.setVector3("sunDirection", lightingSnapshot.sunDirection);
    material.setColor3("sunColor", lightingSnapshot.sunColor);
    material.setColor3("skyColor", lightingSnapshot.skyColor);
    material.setColor3("groundColor", lightingSnapshot.groundColor);
    material.setColor3("fogColor", scene.fogColor);
  });

  let centerCellX = Number.NaN;
  let centerCellZ = Number.NaN;
  const driftDirection = Vector2.Zero();
  copyPrevailingWindDirectionTo(driftDirection);
  const driftStartedAt = performance.now();
  const update = (cameraPosition: Vector3): void => {
    const cellSize = CLOUD_CELL_SIZE_METERS / metersPerUnit;
    const elapsedSeconds = Math.max(0, performance.now() - driftStartedAt) / 1_000;
    const driftDistance = elapsedSeconds * CLOUD_DRIFT_METERS_PER_SECOND / metersPerUnit;
    const driftX = driftDirection.x * driftDistance;
    const driftZ = driftDirection.y * driftDistance;
    mesh.position.set(driftX, 0, driftZ);

    // Select cells in the field's moving frame so its edges remain beyond the fade.
    const nextCellX = Math.floor((cameraPosition.x - driftX) / cellSize);
    const nextCellZ = Math.floor((cameraPosition.z - driftZ) / cellSize);
    if (nextCellX === centerCellX && nextCellZ === centerCellZ) return;
    centerCellX = nextCellX;
    centerCellZ = nextCellZ;

    const placements = cloudPlacementsAround(
      nextCellX,
      nextCellZ,
      CLOUD_FAR_FADE_END_METERS,
      metersPerUnit,
      weatherSeed,
    );
    uploadCloudInstances(mesh, placements);
  };

  const initialCamera = scene.activeCamera;
  if (initialCamera) update(initialCamera.globalPosition);

  return {
    mesh,
    update,
    dispose() {
      material.dispose(false, false);
      atlas.texture.dispose();
      mesh.dispose(false, false);
    },
  };
}

function uploadCloudInstances(mesh: Mesh, placements: readonly CloudPlacement[]): void {
  const matrices = new Float32Array(placements.length * 16);
  const variants = new Float32Array(placements.length);
  const mirrors = new Float32Array(placements.length);
  const rotation = Quaternion.Identity();
  const matrix = Matrix.Identity();
  const scale = Vector3.One();
  const translation = Vector3.Zero();
  for (let index = 0; index < placements.length; index++) {
    const cloud = placements[index];
    scale.set(cloud.width, cloud.height, 1);
    translation.set(cloud.x, cloud.y, cloud.z);
    Matrix.ComposeToRef(
      scale,
      rotation,
      translation,
      matrix,
    );
    matrix.copyToArray(matrices, index * 16);
    variants[index] = cloud.variant;
    mirrors[index] = cloud.mirrored ? 1 : 0;
  }
  mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
  mesh.thinInstanceSetBuffer("cloudVariant", variants, 1, false);
  mesh.thinInstanceSetBuffer("cloudMirror", mirrors, 1, false);
  mesh.thinInstanceCount = placements.length;
  mesh.thinInstanceRefreshBoundingInfo(true);
  mesh.setEnabled(placements.length > 0);
}

function createCloudDensityAtlas(scene: Scene): {
  texture: RawTexture;
  dimensions: Vector2;
  tileStride: Vector2;
  tileSize: Vector2;
} {
  const atlas = generateCloudDensityAtlasData();
  const texture = RawTexture.CreateRGBATexture(
    atlas.pixels,
    atlas.width,
    atlas.height,
    scene,
    true,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
  );
  texture.name = "cloudDensityAtlas";
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return {
    texture,
    dimensions: new Vector2(atlas.width, atlas.height),
    tileStride: new Vector2(atlas.tileStrideX, atlas.tileStrideY),
    tileSize: new Vector2(CLOUD_TEXTURE_WIDTH, CLOUD_TEXTURE_HEIGHT),
  };
}
