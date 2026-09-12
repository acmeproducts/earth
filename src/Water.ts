import {
  BaseTexture,
  BoundingInfo,
  Color3,
  DynamicTexture,
  Material,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  RawTexture,
  Scene,
  StandardMaterial,
  Texture,
  VertexBuffer,
} from '@babylonjs/core';
import type { Nullable, Observer } from '@babylonjs/core';
import { waterFrame } from './WaterFrame';
export { waterMotionSpeed } from './WaterFrame';
import { WaterMotionPlugin } from './WaterMotion';
import { maximumWaterLift, WATER_PROFILES } from './WaterProfile';
import type { WaterSurfaceKind } from './WaterProfile';
export type { WaterSurfaceKind } from './WaterProfile';

const waterMaterials = new WeakMap<Scene, Map<string, PBRMaterial | StandardMaterial>>();
const waterMaterialUsers = new WeakMap<Material, number>();

const WAVE_NORMAL_MAP_URL = 'https://assets.babylonjs.com/textures/waterbump.png';
/** Ground distance spanned by one repeat of the broad swell normal map. */
const SWELL_TILE_METERS = 48;
/**
 * The chop layer repeats this many times inside one swell tile. Keeping this
 * deliberately non-integer prevents both square textures from forming one
 * large, aligned super-grid when a GPU selects a coarser mip level.
 */
const CHOP_TILE_RATIO = 5.37;
/** Metres the swell drifts downwind each second. */
const SWELL_DRIFT_METERS_PER_SECOND = 0.5;
/** Chop rides across the swell rather than with it, so the two never lock. */
const CHOP_DRIFT_METERS_PER_SECOND = 1.4;
/**
 * Normal-map strength was authored around the procedural wind's 0..1 range.
 * Manual weather can report strengths up to 3; feeding that straight into the
 * material exposes the square boundary of every repeated chop tile.
 */
const MAX_WAVE_ROUGHNESS_WIND = 1;
/**
 * Water reflects almost nothing head-on and almost everything at a grazing
 * angle. This is the head-on value; the material's Fresnel term takes it the
 * rest of the way. It sits above SSR's reflectivity threshold so the ocean is
 * the only surface the reflection pass traces.
 */
const WATER_REFLECTIVITY = 0.08;
/** Neutral detail: no albedo or roughness change, and a flat normal. */
const DETAIL_MAP_NEUTRAL = 'rgba(128, 128, 128, 0.502)';
const DETAIL_MAP_SIZE = 256;
/** Shared by the ocean and its terrain-conforming shoreline ribbon. */
export const OCEAN_ELEVATION = -0.01;

/**
 * Creates the ocean plane.
 *
 * Reflections come from two sources that cover each other's gaps: the material
 * reflects `skyReflection` through a Fresnel term, and the scene's screen-space
 * reflection pass traces on-screen geometry — shorelines, buildings, hills —
 * over the top of it. That pass reads normals and reflectivity from the scene
 * prepass, which is why this is a PBR surface: Babylon's WaterMaterial writes
 * neither, so SSR would have nothing to trace from.
 *
 * @param scene - The Babylon.js scene
 * @param options - Configuration options for the water plane
 * @returns The water ground mesh
 */
export function createWaterPlane(
  scene: Scene,
  options: {
    width?: number;
    height?: number;
    subdivisions?: number;
    elevation?: number;
    /** Scene units are not metres; wave scale is authored in metres. */
    metersPerUnit?: number;
    /** Environment the surface reflects where SSR finds nothing on screen. */
    skyReflection?: Nullable<BaseTexture>;
    /** Broad visual character of the water body. */
    kind?: WaterSurfaceKind;
  } = {}
): Mesh {
  const {
    width = 100,
    height = 100,
    // Broad water heaves uniformly; only the shore needs crest tessellation.
    subdivisions = 1,
    elevation = OCEAN_ELEVATION,
    metersPerUnit = 1,
    skyReflection = null,
    kind = 'ocean',
  } = options;

  // Extend slightly beyond the terrain to avoid edge clipping artifacts
  const waterMesh = MeshBuilder.CreateGround(
    'waterMesh',
    { width: width * 1.2, height: height * 1.2, subdivisions },
    scene
  );
  waterMesh.position.y = elevation;
  prepareWaterSurfaceMesh(waterMesh);

  const water = createWaterSurfaceMaterial(scene, {
    width: width * 1.2,
    height: height * 1.2,
    metersPerUnit,
    skyReflection,
    kind,
  });

  bindWaterMaterial(waterMesh, water, metersPerUnit, kind);
  waterMesh.isPickable = false;
  waterMesh.freezeWorldMatrix();
  return waterMesh;
}

export interface WaterSurfaceMaterialOptions {
  /** Kept for callers that describe mesh dimensions; textures use world metres. */
  width: number;
  height: number;
  /** Scene units are not metres; wave scale is authored in metres. */
  metersPerUnit?: number;
  /** Environment the surface reflects where SSR finds nothing on screen. */
  skyReflection?: Nullable<BaseTexture>;
  /** Ocean is deeper, cooler, and more wind-exposed than an inland lake. */
  kind?: WaterSurfaceKind;
  name?: string;
}

/** Creates the shared reflective, animated material used by water meshes. */
export function createWaterSurfaceMaterial(
  scene: Scene,
  options: WaterSurfaceMaterialOptions,
): PBRMaterial | StandardMaterial {
  const {
    metersPerUnit = 1,
    skyReflection = null,
    name = 'waterMaterial',
    kind = 'ocean',
  } = options;

  let cache = waterMaterials.get(scene);
  if (!cache) waterMaterials.set(scene, cache = new Map());
  const key = `${kind}:${metersPerUnit}`;
  const cached = cache.get(key);
  if (cached) {
    if (skyReflection) cached.reflectionTexture = skyReflection;
    return cached;
  }
  const profile = WATER_PROFILES[kind];

  const water = scene.getEngine().isWebGPU
    ? new StandardMaterial(name, scene)
    : new PBRMaterial(name, scene);
  // Custom vegetation shaders render into the scene color and depth buffers,
  // but not into SSR's reflectivity attachment. Draw water in Babylon's alpha
  // test queue (while leaving it fully opaque) so foliage depth is established
  // first and water cannot leave reflectivity behind beneath accepted leaves.
  water.transparencyMode = Material.MATERIAL_ALPHATEST;
  // Deep water read as a plain gamma-space tint before; PBR shades in linear
  // space and converts on output, so convert the authored colour once here
  // instead of re-picking it by eye.
  if (water instanceof PBRMaterial) {
    water.albedoColor = new Color3(...profile.color).toLinearSpace();
    // Leaving metallic/roughness unset keeps the specular-glossiness workflow,
    // where reflectivity is exactly the F0 the prepass hands to SSR.
    water.reflectivityColor = new Color3(
      WATER_REFLECTIVITY,
      WATER_REFLECTIVITY,
      WATER_REFLECTIVITY
    );
    water.microSurface = profile.glossiness;
    water.reflectionTexture = skyReflection;
    water.enableSpecularAntiAliasing = true;
    water.useHorizonOcclusion = true;
  } else {
    // Use Babylon's native StandardMaterial WGSL path as the WebGPU baseline.
    // Direct sun specular keeps it readable without a live reflection probe.
    water.diffuseColor = new Color3(...profile.color);
    water.ambientColor = water.diffuseColor.scale(0.25);
    water.specularColor = new Color3(0.65, 0.76, 0.86);
    water.specularPower = 32 + profile.glossiness * 64;
    water.reflectionTexture = skyReflection;
  }

  const swell = tileOverPlane(
    new Texture(WAVE_NORMAL_MAP_URL, scene),
    'waterSwell',
    SWELL_TILE_METERS
  );
  const chop = tileOverPlane(
    packAsDetailMap(scene, WAVE_NORMAL_MAP_URL),
    'waterChop',
    SWELL_TILE_METERS / CHOP_TILE_RATIO
  );
  water.bumpTexture = swell;
  // Babylon's detail map reads its normal from green and alpha, not from an
  // RGB normal map, so the second wave scale is packed into that layout
  // instead of being handed the bump image directly.
  water.detailMap.texture = chop;
  water.detailMap.bumpLevel = profile.chopNormal;
  water.detailMap.diffuseBlendLevel = 0;
  water.detailMap.roughnessBlendLevel = 0;
  water.detailMap.isEnabled = true;

  animateWaves(scene, water, swell, chop, kind);
  new WaterMotionPlugin(water, metersPerUnit, profile);
  cache.set(key, water);
  water.onDisposeObservable.add(() => { cache.delete(key); });
  return water;
}

/** Every water mesh holds a reference; streamed tiles cannot dispose a sibling's material. */
export function bindWaterMaterial(
  mesh: Mesh,
  material: PBRMaterial | StandardMaterial,
  metersPerUnit: number,
  kind: WaterSurfaceKind,
): void {
  mesh.material = material;
  waterMaterialUsers.set(material, (waterMaterialUsers.get(material) ?? 0) + 1);
  const bounds = mesh.getBoundingInfo();
  const padding = (maximumWaterLift(WATER_PROFILES[kind]) + 0.001) / metersPerUnit;
  const minimum = bounds.minimum.clone();
  const maximum = bounds.maximum.clone();
  minimum.y -= padding;
  maximum.y += padding;
  mesh.setBoundingInfo(new BoundingInfo(minimum, maximum));
  mesh.onDisposeObservable.add(() => {
    mesh.material = null;
    const remaining = (waterMaterialUsers.get(material) ?? 1) - 1;
    waterMaterialUsers.set(material, remaining);
    if (remaining === 0) {
      material.reflectionTexture = null;
      material.dispose(false, true);
    }
  });
}

/**
 * Releases this plane's reference to the shared water material.
 *
 * The last water mesh releases its wave textures. Its borrowed sky reflection
 * remains owned by the lighting, including during world/location changes.
 */
export function disposeWaterPlane(waterMesh: Mesh): void {
  waterMesh.dispose(false, false);
}

/**
 * Without tangents, Babylon rebuilds the wave normal map's frame per pixel from
 * screen-space derivatives. Across a plane this wide, seen almost edge-on, that
 * frame collapses and the shaded normals swing round to face the camera: the
 * surface reads as flat and the reflection pass traces rays straight back into
 * the water. A ground plane's tangent frame is the same everywhere, so state it
 * once rather than letting the shader guess it.
 */
export function prepareWaterSurfaceMesh(mesh: Mesh): void {
  const vertexCount = mesh.getTotalVertices();
  const tangents = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    tangents[vertex * 4] = 1; // +X, matching the ground's U direction.
    tangents[vertex * 4 + 3] = 1; // Handedness of the derived bitangent.
  }
  mesh.setVerticesData(VertexBuffer.TangentKind, tangents);
  // x = terrain height relative to water in metres, y = crest-enabled region.
  // Broad ocean and lake polygons use the common heave, without shore crests.
  const shore = new Float32Array(vertexCount * 2);
  for (let vertex = 0; vertex < vertexCount; vertex++) shore[vertex * 2] = -100;
  mesh.setVerticesData('waterShore', shore, false, 2);
  if (!mesh.isVerticesDataPresent(VertexBuffer.UVKind)) {
    mesh.setVerticesData(VertexBuffer.UVKind, new Float32Array(vertexCount * 2));
  }
}

/** Repeats a wave layer so one tile covers a fixed real-world distance. */
function tileOverPlane(
  texture: Texture,
  name: string,
  tileMeters: number
): Texture {
  texture.name = name;
  texture.uScale = 1 / tileMeters;
  texture.vScale = 1 / tileMeters;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  // The ocean runs to the horizon, so most of it is seen at a grazing angle
  // where trilinear filtering alone smears the waves into a flat band.
  texture.anisotropicFilteringLevel = 16;
  return texture;
}

/**
 * Repacks the wave normal map into the layout Babylon's detail map expects:
 * red modulates albedo around a half, blue does the same for roughness, and
 * the normal's x and y live in alpha and green. Handing it the RGB normal map
 * unchanged reads full alpha as a maximal sideways tilt, which lays the
 * surface over on its side.
 *
 * The repack needs the decoded pixels, so it lands a frame or two after the
 * image arrives; until then, and if the source cannot be read back, the
 * texture stays neutral and only the primary wave layer shows.
 */
function packAsDetailMap(scene: Scene, url: string): Texture {
  if (typeof document === 'undefined') {
    return RawTexture.CreateRGBATexture(new Uint8Array([128, 128, 128, 128]), 1, 1, scene);
  }
  const packed = new DynamicTexture(
    'waterChopDetail',
    { width: DETAIL_MAP_SIZE, height: DETAIL_MAP_SIZE },
    scene,
    true
  );
  const context = packed.getContext();
  context.fillStyle = DETAIL_MAP_NEUTRAL;
  context.fillRect(0, 0, DETAIL_MAP_SIZE, DETAIL_MAP_SIZE);
  packed.update();

  let disposed = false;
  packed.onDisposeObservable.add(() => {
    disposed = true;
  });
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = (): void => {
    if (disposed) return;
    try {
      context.drawImage(image, 0, 0, DETAIL_MAP_SIZE, DETAIL_MAP_SIZE);
      const pixels = context.getImageData(0, 0, DETAIL_MAP_SIZE, DETAIL_MAP_SIZE);
      for (let offset = 0; offset < pixels.data.length; offset += 4) {
        const normalX = pixels.data[offset];
        const normalY = pixels.data[offset + 1];
        pixels.data[offset] = 128;
        pixels.data[offset + 1] = normalY;
        pixels.data[offset + 2] = 128;
        pixels.data[offset + 3] = normalX;
      }
      context.putImageData(pixels, 0, 0);
      packed.update();
    } catch (error) {
      console.warn("Wave detail layer unavailable; the surface keeps one wave scale.", error);
      context.fillStyle = DETAIL_MAP_NEUTRAL;
      context.fillRect(0, 0, DETAIL_MAP_SIZE, DETAIL_MAP_SIZE);
      packed.update();
    }
  };
  image.src = url;
  return packed;
}

/**
 * Scrolls both wave layers. A texture offset of 1 shifts the pattern by
 * exactly one tile whatever the tiling, so each layer's real-world speed
 * converts through its own tile size and the two stay physically consistent.
 */
function animateWaves(
  scene: Scene,
  water: PBRMaterial | StandardMaterial,
  swell: Texture,
  chop: Texture,
  kind: WaterSurfaceKind,
): void {
  const swellRepeatsPerSecond = SWELL_DRIFT_METERS_PER_SECOND / SWELL_TILE_METERS;
  const chopRepeatsPerSecond =
    (CHOP_DRIFT_METERS_PER_SECOND * CHOP_TILE_RATIO) / SWELL_TILE_METERS;
  const observer: Nullable<Observer<Scene>> = scene.onBeforeRenderObservable.add(() => {
    // Shared accumulated drift keeps separately streamed materials in phase.
    const { driftX, driftY, wind } = waterFrame(scene);
    const profile = WATER_PROFILES[kind];
    const exposure = profile.exposure;
    // Each layer runs on its own heading so the surface never looks like one
    // sheet sliding past the camera.
    // Different starting phases keep the two copies of the same source image
    // from reinforcing its square tile boundaries.
    swell.uOffset = 0.173 + driftX * swellRepeatsPerSecond * exposure;
    swell.vOffset = 0.417 + driftY * swellRepeatsPerSecond * exposure;
    chop.uOffset = 0.631 - driftY * chopRepeatsPerSecond * exposure * 0.55;
    chop.vOffset = 0.289 + driftX * chopRepeatsPerSecond * exposure;
    // Wind makes the surface more broken without changing the authored look
    // at calm conditions. Lakes respond less dramatically than open sea.
    const roughnessWind = Math.min(MAX_WAVE_ROUGHNESS_WIND, wind.strength);
    const chopLevel = profile.chopNormal * (0.72 + roughnessWind * 0.28);
    water.bumpTexture!.level = profile.swellNormal * (0.78 + roughnessWind * 0.22);
    water.detailMap.bumpLevel = chopLevel;
  });

  // The plane is rebuilt whenever the world moves; the ticker must go with it.
  water.onDisposeObservable.add(() => {
    scene.onBeforeRenderObservable.remove(observer);
  });
}
