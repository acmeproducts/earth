import {
  BaseTexture,
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Nullable,
  Observer,
  PBRMaterial,
  Scene,
  Texture,
  VertexBuffer,
} from '@babylonjs/core';

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
 * Water reflects almost nothing head-on and almost everything at a grazing
 * angle. This is the head-on value; the material's Fresnel term takes it the
 * rest of the way. It sits above SSR's reflectivity threshold so the ocean is
 * the only surface the reflection pass traces.
 */
const WATER_REFLECTIVITY = 0.08;
/** Neutral detail: no albedo or roughness change, and a flat normal. */
const DETAIL_MAP_NEUTRAL = 'rgba(128, 128, 128, 0.502)';
const DETAIL_MAP_SIZE = 256;

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
  } = {}
): Mesh {
  const {
    width = 100,
    height = 100,
    // This surface has no vertex displacement. One quad avoids exposing an
    // otherwise pointless 64x64 triangle grid on precision-sensitive GPUs.
    subdivisions = 1,
    elevation = -0.01,
    metersPerUnit = 1,
    skyReflection = null,
  } = options;

  // Extend slightly beyond the terrain to avoid edge clipping artifacts
  const waterMesh = MeshBuilder.CreateGround(
    'waterMesh',
    { width: width * 1.2, height: height * 1.2, subdivisions },
    scene
  );
  waterMesh.position.y = elevation;
  giveConstantTangentFrame(waterMesh);

  const water = new PBRMaterial('waterMaterial', scene);
  // Deep water read as a plain gamma-space tint before; PBR shades in linear
  // space and converts on output, so convert the authored colour once here
  // instead of re-picking it by eye.
  water.albedoColor = new Color3(0.05, 0.2, 0.4).toLinearSpace();
  // Leaving metallic/roughness unset keeps the specular-glossiness workflow,
  // where reflectivity is exactly the F0 the prepass hands to SSR.
  water.reflectivityColor = new Color3(
    WATER_REFLECTIVITY,
    WATER_REFLECTIVITY,
    WATER_REFLECTIVITY
  );
  water.microSurface = 0.9;
  water.reflectionTexture = skyReflection;
  // Wave normals are far finer than the pixels they cover at any distance;
  // without this the sun turns the whole surface into crawling white noise.
  water.enableSpecularAntiAliasing = true;
  // Waves cannot reflect what is below the surface they sit on.
  water.useHorizonOcclusion = true;

  const swellTileUnits = SWELL_TILE_METERS / metersPerUnit;
  const swell = tileOverPlane(
    new Texture(WAVE_NORMAL_MAP_URL, scene),
    'waterSwell',
    width,
    height,
    swellTileUnits
  );
  const chop = tileOverPlane(
    packAsDetailMap(scene, WAVE_NORMAL_MAP_URL),
    'waterChop',
    width,
    height,
    swellTileUnits / CHOP_TILE_RATIO
  );
  water.bumpTexture = swell;
  // Babylon's detail map reads its normal from green and alpha, not from an
  // RGB normal map, so the second wave scale is packed into that layout
  // instead of being handed the bump image directly.
  water.detailMap.texture = chop;
  water.detailMap.bumpLevel = 0.6;
  water.detailMap.diffuseBlendLevel = 0;
  water.detailMap.roughnessBlendLevel = 0;
  water.detailMap.isEnabled = true;

  animateWaves(scene, water, swell, chop);

  waterMesh.material = water;
  waterMesh.isPickable = false;
  waterMesh.freezeWorldMatrix();
  return waterMesh;
}

/**
 * Tears down a water plane and the wave textures it owns.
 *
 * The sky reflection is not one of them: it belongs to the lighting and is
 * still in use after the plane goes, but Babylon's forced texture disposal
 * walks every texture slot on the material and would take it down too.
 */
export function disposeWaterPlane(waterMesh: Mesh): void {
  const material = waterMesh.material;
  if (material instanceof PBRMaterial) material.reflectionTexture = null;
  waterMesh.dispose(false, true);
}

/**
 * Without tangents, Babylon rebuilds the wave normal map's frame per pixel from
 * screen-space derivatives. Across a plane this wide, seen almost edge-on, that
 * frame collapses and the shaded normals swing round to face the camera: the
 * surface reads as flat and the reflection pass traces rays straight back into
 * the water. A ground plane's tangent frame is the same everywhere, so state it
 * once rather than letting the shader guess it.
 */
function giveConstantTangentFrame(mesh: Mesh): void {
  const vertexCount = mesh.getTotalVertices();
  const tangents = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    tangents[vertex * 4] = 1; // +X, matching the ground's U direction.
    tangents[vertex * 4 + 3] = 1; // Handedness of the derived bitangent.
  }
  mesh.setVerticesData(VertexBuffer.TangentKind, tangents);
}

/** Repeats a wave layer so one tile covers a fixed real-world distance. */
function tileOverPlane(
  texture: Texture,
  name: string,
  width: number,
  height: number,
  tileUnits: number
): Texture {
  texture.name = name;
  texture.uScale = Math.max(1, (width * 1.2) / tileUnits);
  texture.vScale = Math.max(1, (height * 1.2) / tileUnits);
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
  water: PBRMaterial,
  swell: Texture,
  chop: Texture
): void {
  const swellRepeatsPerSecond = SWELL_DRIFT_METERS_PER_SECOND / SWELL_TILE_METERS;
  const chopRepeatsPerSecond =
    (CHOP_DRIFT_METERS_PER_SECOND * CHOP_TILE_RATIO) / SWELL_TILE_METERS;
  let seconds = 0;

  const observer: Nullable<Observer<Scene>> = scene.onBeforeRenderObservable.add(() => {
    seconds += scene.getEngine().getDeltaTime() / 1000;
    // Each layer runs on its own heading so the surface never looks like one
    // sheet sliding past the camera.
    // Different starting phases keep the two copies of the same source image
    // from reinforcing its square tile boundaries.
    swell.uOffset = 0.173 + seconds * swellRepeatsPerSecond * 0.8;
    swell.vOffset = 0.417 + seconds * swellRepeatsPerSecond * 0.6;
    chop.uOffset = 0.631 + seconds * chopRepeatsPerSecond * -0.4;
    chop.vOffset = 0.289 + seconds * chopRepeatsPerSecond;
  });

  // The plane is rebuilt whenever the world moves; the ticker must go with it.
  water.onDisposeObservable.add(() => {
    scene.onBeforeRenderObservable.remove(observer);
  });
}
