import {
  Color4,
  Constants,
  FreeCamera,
  Mesh,
  RawTexture,
  RenderTargetTexture,
  Scene,
  Texture,
  Vector3,
  Viewport,
} from "@babylonjs/core";
import {
  setVegetationWindPhase,
  setVegetationWindSway,
  waitForVertexColorTextures,
} from "./ProceduralCaptureMaterial";
import { windSwayReach } from "./Wind";

export interface ImpostorAssets {
  /** Raw RGBA atlases preserve hidden edge colors used by bilinear filtering. */
  textures: Texture[];
  /** Source canvases retained for the capture preview and validation tools. */
  atlasCanvases: HTMLCanvasElement[];
  /** Per-frame downsampled atlases used once an impostor is small on screen. */
  lowResolutionTextures: Texture[];
  rotationallySymmetric: boolean;
  rotationalSymmetryOrder: number;
  /** Side-face rows start at a level view instead of including views from below. */
  upperHemisphereOnly: boolean;
  gridWidth: number;
  gridHeight: number;
  /**
   * Captured moments of the wind loop, laid out along the atlas's tile-column
   * axis after the directional grid. One means a motionless capture.
   */
  timeSamples: number;
  /** Kept for the square-grid validation tools. */
  gridSize: number;
  resolution: number;
  resolutionWidth: number;
  resolutionHeight: number;
  lowResolutionWidth: number;
  lowResolutionHeight: number;
  sourceHeight: number;
  captureDiameter: number;
  captureWidth: number;
  captureHeight: number;
}

/** Capture work per yielded frame, decoupling atlas speed from display refresh. */
const CAPTURE_FRAME_BUDGET_MS = 12;

/** Target height of each frame in the distant impostor atlas. */
const LOW_RESOLUTION_FRAME_SIZE = 20;
/** Any meaningful source coverage becomes a solid distant texel. */
const LOW_RESOLUTION_ALPHA_THRESHOLD = 8;

export interface CubeFace {
  normal: Vector3;
  right: Vector3;
  up: Vector3;
}

export const IMPOSTOR_CUBE_FACES: readonly CubeFace[] = [
  { normal: new Vector3(1, 0, 0), right: new Vector3(0, 0, -1), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(-1, 0, 0), right: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(0, 1, 0), right: new Vector3(1, 0, 0), up: new Vector3(0, 0, -1) },
  { normal: new Vector3(0, 0, 1), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(0, 0, -1), right: new Vector3(-1, 0, 0), up: new Vector3(0, 1, 0) },
];

/** One side and the top are sufficient for sources symmetric around the Y axis. */
export const AXISYMMETRIC_IMPOSTOR_FACES: readonly CubeFace[] = [
  IMPOSTOR_CUBE_FACES[0],
  IMPOSTOR_CUBE_FACES[2],
];

export interface ImpostorCaptureOptions {
  name: string;
  meshes: Mesh[];
  gridWidth: number;
  gridHeight: number;
  timeSamples?: number;
  resolution: number;
  resolutionWidth?: number;
  resolutionHeight?: number;
  sourceHeight: number;
  captureDiameter: number;
  captureWidth?: number;
  captureHeight?: number;
  faces?: readonly CubeFace[];
  rotationallySymmetric?: boolean;
  rotationalSymmetryOrder?: number;
  /** Captures side faces from level through overhead; top faces retain their full range. */
  upperHemisphereOnly?: boolean;
  /** Poses the source at one moment of the wind loop before its views render. */
  setTimePhase?: (phase: number) => void;
  onProgress?: (
    completed: number,
    total: number,
    faceIndex: number,
    x: number,
    y: number,
  ) => void;
}

export interface ImpostorSampling {
  horizontalSamples: number;
  verticalSamples: number;
  timeSamples: number;
  resolution: number;
}

export interface ImpostorParameter {
  default: number;
  minimum: number;
  maximum: number;
}

export interface ImpostorDefinition {
  /** Stable identifier used for Babylon resources and logs. */
  name: string;
  /** Defaults to `name`; useful when resource names and public parameters differ. */
  queryPrefix?: string;
  createSource(scene: Scene): Mesh | Mesh[] | Promise<Mesh | Mesh[]>;
  sourceHeight: number;
  captureDiameter: number;
  captureWidth?: number;
  captureHeight?: number;
  /** Fits width and height to the generated mesh bounds with this multiplier. */
  boundsPadding?: number;
  preserveCaptureAspectRatio?: boolean;
  minimumResolutionWidth?: number;
  faces?: readonly CubeFace[];
  rotationallySymmetric?: boolean;
  rotationalSymmetryOrder?: number;
  /** Omits below-object angles from side-face atlas rows. Defaults to false. */
  upperHemisphereOnly?: boolean;
  /**
   * Captures a looping wind animation as an extra atlas dimension. Only makes
   * sense for sources whose atlas covers every azimuth: a sway has a direction,
   * which a rotationally symmetric capture cannot represent.
   */
  wind?: {
    /** Horizontal crown swing as a fraction of the source height. */
    swayFraction: number;
    timeSamples: ImpostorParameter;
  };
  sampling: {
    horizontalSamples: ImpostorParameter;
    verticalSamples: ImpostorParameter;
    resolution: ImpostorParameter;
  };
}

export interface ImpostorAssetProvider {
  getAssets(scene: Scene, sampling?: Partial<ImpostorSampling>): Promise<ImpostorAssets>;
  getDefaultSampling(): ImpostorSampling;
}

/**
 * Turns a procedural source descriptor into a lazy, per-scene atlas provider.
 * Adding a new model only requires a descriptor and its geometry factory.
 */
export function createImpostorAssetProvider(
  definition: ImpostorDefinition,
): ImpostorAssetProvider {
  const sceneAssets = new WeakMap<Scene, Map<string, Promise<ImpostorAssets>>>();
  const queryPrefix = definition.queryPrefix ?? definition.name;

  const getDefaultSampling = (): ImpostorSampling => ({
    horizontalSamples: queryParameter(
      `${queryPrefix}-x-samples`,
      definition.sampling.horizontalSamples,
    ),
    verticalSamples: queryParameter(
      `${queryPrefix}-y-samples`,
      definition.sampling.verticalSamples,
    ),
    timeSamples: definition.wind
      ? queryParameter(`${queryPrefix}-time-samples`, definition.wind.timeSamples)
      : 1,
    resolution: queryParameter(
      `${queryPrefix}-resolution`,
      definition.sampling.resolution,
    ),
  });

  return {
    getDefaultSampling,
    getAssets(scene, overrides = {}) {
      const sampling = { ...getDefaultSampling(), ...overrides };
      validateSampling(definition, sampling);
      let cache = sceneAssets.get(scene);
      if (!cache) {
        cache = new Map();
        sceneAssets.set(scene, cache);
      }

      const key = [
        sampling.horizontalSamples,
        sampling.verticalSamples,
        sampling.timeSamples,
        sampling.resolution,
      ].join(":");
      const existing = cache.get(key);
      if (existing) return existing;

      const capture = captureDefinition(scene, definition, sampling);
      cache.set(key, capture);
      capture.catch(() => {
        if (cache?.get(key) === capture) cache.delete(key);
      });
      return capture;
    },
  };
}

async function captureDefinition(
  scene: Scene,
  definition: ImpostorDefinition,
  sampling: ImpostorSampling,
): Promise<ImpostorAssets> {
  const created = await definition.createSource(scene);
  const meshes = Array.isArray(created) ? created : [created];
  if (meshes.length === 0) throw new Error(`${definition.name} created no source meshes.`);

  // A lazily discovered source belongs only to its render target. Keep it out
  // of gameplay frames while textures become ready and between capture views.
  meshes.forEach((mesh) => { mesh.isVisible = false; });

  try {
    // Invisible capture sources are not a reliable part of Babylon's scene
    // readiness checks. Explicitly wait for their optional foliage cutouts so
    // every atlas direction is captured with the same material state.
    await waitForVertexColorTextures(meshes);
    await scene.whenReadyAsync();
    let captureWidth = definition.captureWidth ?? definition.captureDiameter;
    let captureHeight = definition.captureHeight ?? definition.captureDiameter;
    if (definition.boundsPadding !== undefined) {
      const bounds = sourceDimensions(meshes);
      captureWidth = Math.max(bounds.x, bounds.z) * definition.boundsPadding;
      captureHeight = bounds.y * definition.boundsPadding;
    }
    const swayFraction = definition.wind?.swayFraction ?? 0;
    if (swayFraction > 0) {
      // A capture source is built around the origin, so its base sits half a
      // source height below it.
      setVegetationWindSway(
        meshes,
        swayFraction,
        -definition.sourceHeight / 2,
        definition.sourceHeight,
      );
      // Sway is horizontal, and the bounding box measured above describes only
      // the still pose. Widen the frame or the leaning crown is clipped off.
      captureWidth += 2 * windSwayReach(definition.sourceHeight, swayFraction);
    }
    const resolutionWidth = definition.preserveCaptureAspectRatio
      ? Math.max(
        definition.minimumResolutionWidth ?? 1,
        Math.round(sampling.resolution * captureWidth / captureHeight),
      )
      : sampling.resolution;

    const assets = await captureImpostorAtlases(scene, {
      name: definition.name,
      meshes,
      gridWidth: sampling.horizontalSamples,
      gridHeight: sampling.verticalSamples,
      timeSamples: sampling.timeSamples,
      resolution: sampling.resolution,
      resolutionWidth,
      resolutionHeight: sampling.resolution,
      sourceHeight: definition.sourceHeight,
      captureDiameter: definition.captureDiameter,
      captureWidth,
      captureHeight,
      faces: definition.faces,
      rotationallySymmetric: definition.rotationallySymmetric,
      rotationalSymmetryOrder: definition.rotationalSymmetryOrder,
      upperHemisphereOnly: definition.upperHemisphereOnly,
      setTimePhase: swayFraction > 0
        ? (phase) => setVegetationWindPhase(meshes, phase)
        : undefined,
    });
    console.log(`${definition.name}: capture complete; procedural source disposed`);
    return assets;
  } finally {
    const materials = new Set(meshes.map((mesh) => mesh.material).filter((material) => material !== null));
    meshes.forEach((mesh) => mesh.dispose(false, false));
    // Capture sources may use scene-cached procedural textures that remain
    // useful to live models after the temporary source material is gone.
    materials.forEach((material) => material.dispose(true, false));
  }
}

function sourceDimensions(meshes: readonly Mesh[]): Vector3 {
  let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    mesh.refreshBoundingInfo();
    const bounds = mesh.getBoundingInfo().boundingBox;
    minimum = Vector3.Minimize(minimum, bounds.minimumWorld);
    maximum = Vector3.Maximize(maximum, bounds.maximumWorld);
  }
  return maximum.subtract(minimum);
}

const MOTIONLESS_TIME_SAMPLES: ImpostorParameter = { default: 1, minimum: 1, maximum: 1 };

function validateSampling(definition: ImpostorDefinition, sampling: ImpostorSampling): void {
  for (const [name, value, limits] of [
    ["horizontalSamples", sampling.horizontalSamples, definition.sampling.horizontalSamples],
    ["verticalSamples", sampling.verticalSamples, definition.sampling.verticalSamples],
    ["timeSamples", sampling.timeSamples, definition.wind?.timeSamples ?? MOTIONLESS_TIME_SAMPLES],
    ["resolution", sampling.resolution, definition.sampling.resolution],
  ] as const) {
    if (!Number.isInteger(value) || value < limits.minimum || value > limits.maximum) {
      throw new Error(
        `${definition.name} ${name} must be an integer from ${limits.minimum} to ${limits.maximum}.`,
      );
    }
  }
}

function queryParameter(name: string, parameter: ImpostorParameter): number {
  if (typeof window === "undefined") return parameter.default;
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value >= parameter.minimum && value <= parameter.maximum
    ? Math.round(value)
    : parameter.default;
}

/** Captures an origin-centered source into the requested directional atlases. */
export async function captureImpostorAtlases(
  scene: Scene,
  options: ImpostorCaptureOptions,
): Promise<ImpostorAssets> {
  const {
    name,
    meshes,
    gridWidth,
    gridHeight,
    timeSamples = 1,
    resolution,
    resolutionWidth = resolution,
    resolutionHeight = resolution,
    sourceHeight,
    captureDiameter,
    captureWidth = captureDiameter,
    captureHeight = captureDiameter,
    faces = IMPOSTOR_CUBE_FACES,
    rotationallySymmetric = false,
    rotationalSymmetryOrder = 0,
    upperHemisphereOnly = false,
    setTimePhase,
    onProgress,
  } = options;
  // Moments of the wind loop extend the directional grid along the tile-column
  // axis, so one atlas per face still holds every view.
  const atlasColumns = gridWidth * timeSamples;
  const atlasWidth = atlasColumns * resolutionWidth;
  const atlasHeight = gridHeight * resolutionHeight;
  const maxTextureSize = scene.getEngine().getCaps().maxTextureSize;
  if (atlasWidth > maxTextureSize || atlasHeight > maxTextureSize) {
    throw new Error(
      `${name} atlas ${atlasWidth}x${atlasHeight}px exceeds the GPU limit of ${maxTextureSize}px.`,
    );
  }
  console.log(
    `${name}: capturing ${faces.length * atlasColumns * gridHeight} views ` +
    `(${gridWidth}x${gridHeight} directions x ${timeSamples} wind moments per face) ` +
    `at ${resolutionWidth}x${resolutionHeight}`,
  );

  const canvases = faces.map(() => {
    const canvas = document.createElement("canvas");
    canvas.width = atlasWidth;
    canvas.height = atlasHeight;
    return canvas;
  });
  const camera = new FreeCamera(`${name}CaptureCamera`, Vector3.Zero(), scene);
  camera.mode = FreeCamera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = 0.01;
  camera.maxZ = captureDiameter * 4;
  camera.orthoLeft = -captureWidth / 2;
  camera.orthoRight = captureWidth / 2;
  // All of a face's views render into one atlas-sized target through per-tile
  // camera viewports, so the whole face needs a single GPU readback instead of
  // one synchronous pipeline stall per view.
  const target = new RenderTargetTexture(
    `${name}CaptureTarget`,
    { width: atlasWidth, height: atlasHeight },
    scene,
    false,
    false,
  );
  target.clearColor = new Color4(0, 0, 0, 0);
  target.renderList = meshes;
  target.activeCamera = camera;
  target.samples = 1;
  // The default clear wipes the full target on every tile render, erasing the
  // tiles already captured. Tiles occupy disjoint viewport regions, so color
  // and depth only need clearing once per face.
  let clearPending = true;
  target.onClearObservable.add(() => {
    if (!clearPending) return;
    scene.getEngine().clear(target.clearColor, true, true, true);
    clearPending = false;
  });
  const sourceVisibility = meshes.map((mesh) => mesh.isVisible);
  const total = faces.length * atlasColumns * gridHeight;
  let completed = 0;
  let sliceStart = performance.now();

  try {
    for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
      const face = faces[faceIndex];
      const context = canvases[faceIndex].getContext("2d", { alpha: true })!;
      const verticalSpan = Math.abs(face.normal.y) > 0.5 ? captureWidth : captureHeight;
      camera.orthoTop = verticalSpan / 2;
      camera.orthoBottom = -verticalSpan / 2;
      clearPending = true;
      for (let timeIndex = 0; timeIndex < timeSamples; timeIndex++) {
        // The loop is periodic, so the last moment must not repeat the first:
        // sampling i/timeSamples leaves the wrap-around blend one step wide.
        setTimePhase?.(timeIndex / timeSamples);
        for (let y = 0; y < gridHeight; y++) {
          for (let x = 0; x < gridWidth; x++) {
            const u = gridWidth === 1 ? 0 : (x / (gridWidth - 1)) * 2 - 1;
            const fullRangeV = gridHeight === 1 ? 0 : (y / (gridHeight - 1)) * 2 - 1;
            const isSideFace = Math.abs(face.normal.y) <= 0.5;
            const v = upperHemisphereOnly && isSideFace
              ? (fullRangeV + 1) * 0.5
              : fullRangeV;
            const direction = face.normal.add(face.right.scale(u)).add(face.up.scale(v)).normalize();
            camera.position.copyFrom(direction.scale(captureDiameter));
            camera.upVector.copyFrom(face.up);
            camera.setTarget(Vector3.Zero());
            const column = timeIndex * gridWidth + x;
            // The readback conversion flips the atlas vertically, so grid row 0
            // renders at the top of the bottom-up GL target to end up on top.
            camera.viewport = new Viewport(
              column / atlasColumns,
              (gridHeight - 1 - y) / gridHeight,
              1 / atlasColumns,
              1 / gridHeight,
            );
            meshes.forEach((mesh) => { mesh.isVisible = true; });
            try {
              target.render(true);
            } finally {
              meshes.forEach((mesh) => { mesh.isVisible = false; });
            }
            completed++;
            onProgress?.(completed, total, faceIndex, x, y);
            if (performance.now() - sliceStart > CAPTURE_FRAME_BUDGET_MS) {
              await nextFrame();
              sliceStart = performance.now();
            }
          }
        }
      }
      const pixels = await target.readPixels();
      if (!pixels) throw new Error(`${name} GPU readback failed.`);
      context.putImageData(binaryImage(pixels, atlasWidth, atlasHeight, context), 0, 0);
      await nextFrame();
      sliceStart = performance.now();
    }
  } finally {
    meshes.forEach((mesh, index) => { mesh.isVisible = sourceVisibility[index]; });
    target.dispose();
    camera.dispose();
  }

  return createImpostorTextures(scene, name, canvases, {
    rotationallySymmetric,
    rotationalSymmetryOrder,
    upperHemisphereOnly,
    gridWidth,
    gridHeight,
    timeSamples,
    resolution: resolutionHeight,
    resolutionWidth,
    resolutionHeight,
    lowResolutionWidth: Math.max(
      1,
      Math.round(LOW_RESOLUTION_FRAME_SIZE * resolutionWidth / resolutionHeight),
    ),
    lowResolutionHeight: LOW_RESOLUTION_FRAME_SIZE,
    sourceHeight,
    captureDiameter,
    captureWidth,
    captureHeight,
  });
}

function createImpostorTextures(
  scene: Scene,
  name: string,
  canvases: HTMLCanvasElement[],
  metadata: Omit<
    ImpostorAssets,
    "textures" | "atlasCanvases" | "lowResolutionTextures" | "gridSize"
  >,
): ImpostorAssets {
  const atlasColumns = metadata.gridWidth * metadata.timeSamples;
  const atlasWidth = atlasColumns * metadata.resolutionWidth;
  const atlasHeight = metadata.gridHeight * metadata.resolutionHeight;
  const textures = canvases.map((canvas, index) => {
    const image = canvas.getContext("2d", { alpha: true })!.getImageData(
      0,
      0,
      atlasWidth,
      atlasHeight,
    );
    // A canvas texture is uploaded through a premultiplied backing store, which
    // commonly turns RGB under zero alpha black. Thin grass silhouettes then
    // acquire a dark line when bilinear filtering reaches across their edge.
    // RawTexture keeps this two-pixel, per-frame color gutter intact.
    dilateTransparentTileEdgeColors(
      image,
      atlasColumns,
      metadata.gridHeight,
      metadata.resolutionWidth,
      metadata.resolutionHeight,
      2,
    );
    const texture = new RawTexture(
      image.data,
      atlasWidth,
      atlasHeight,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
    );
    texture.name = `${name}Atlas${index}`;
    texture.gammaSpace = false;
    texture.hasAlpha = true;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    return texture;
  });
  const lowResolutionTextures = canvases.map((canvas, index) => {
    const lowImage = downsampleAtlasTiles(
      canvas,
      atlasColumns,
      metadata.gridHeight,
      metadata.resolutionWidth,
      metadata.resolutionHeight,
      metadata.lowResolutionWidth,
      metadata.lowResolutionHeight,
    );
    const texture = new RawTexture(
      lowImage.data,
      lowImage.width,
      lowImage.height,
      Constants.TEXTUREFORMAT_RGBA,
      scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
    );
    texture.name = `${name}LowResolutionAtlas${index}`;
    texture.gammaSpace = false;
    texture.hasAlpha = true;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    return texture;
  });
  return {
    textures,
    atlasCanvases: canvases,
    lowResolutionTextures,
    ...metadata,
    gridSize: metadata.gridWidth,
  };
}

/** Extends opaque RGB just far enough to cover the bilinear footprint. */
function dilateTransparentTileEdgeColors(
  image: ImageData,
  gridWidth: number,
  gridHeight: number,
  tileWidth: number,
  tileHeight: number,
  radius: number,
): void {
  const source = new Uint8ClampedArray(image.data);
  for (let tileY = 0; tileY < gridHeight; tileY++) {
    for (let tileX = 0; tileX < gridWidth; tileX++) {
      const startX = tileX * tileWidth;
      const startY = tileY * tileHeight;
      for (let localY = 0; localY < tileHeight; localY++) {
        for (let localX = 0; localX < tileWidth; localX++) {
          const x = startX + localX;
          const y = startY + localY;
          const destination = (y * image.width + x) * 4;
          if (source[destination + 3] !== 0) continue;

          let nearest = -1;
          let nearestDistanceSquared = Number.POSITIVE_INFINITY;
          for (let offsetY = -radius; offsetY <= radius; offsetY++) {
            const sampleY = localY + offsetY;
            if (sampleY < 0 || sampleY >= tileHeight) continue;
            for (let offsetX = -radius; offsetX <= radius; offsetX++) {
              const sampleX = localX + offsetX;
              if (sampleX < 0 || sampleX >= tileWidth) continue;
              const distanceSquared = offsetX * offsetX + offsetY * offsetY;
              if (distanceSquared > radius * radius || distanceSquared >= nearestDistanceSquared) {
                continue;
              }
              const sample = (
                (startY + sampleY) * image.width + startX + sampleX
              ) * 4;
              if (source[sample + 3] === 0) continue;
              nearest = sample;
              nearestDistanceSquared = distanceSquared;
            }
          }
          if (nearest >= 0) {
            image.data[destination] = source[nearest];
            image.data[destination + 1] = source[nearest + 1];
            image.data[destination + 2] = source[nearest + 2];
          }
        }
      }
    }
  }
}

/** Downsamples frames independently so neighboring atlas tiles cannot bleed together. */
function downsampleAtlasTiles(
  source: HTMLCanvasElement,
  gridWidth: number,
  gridHeight: number,
  sourceTileWidth: number,
  sourceTileHeight: number,
  targetTileWidth: number,
  targetTileHeight: number,
): ImageData {
  const target = document.createElement("canvas");
  target.width = gridWidth * targetTileWidth;
  target.height = gridHeight * targetTileHeight;
  const context = target.getContext("2d", { alpha: true })!;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      context.drawImage(
        source,
        x * sourceTileWidth,
        y * sourceTileHeight,
        sourceTileWidth,
        sourceTileHeight,
        x * targetTileWidth,
        y * targetTileHeight,
        targetTileWidth,
        targetTileHeight,
      );
    }
  }
  const pixels = context.getImageData(0, 0, target.width, target.height);
  // The regular impostor shader uses alpha testing, not alpha blending. At
  // At low resolution, retaining averaged fractional coverage produces a conspicuous Bayer
  // pattern of holes. Preserve the filtered color but make meaningful distant
  // coverage solid so sub-pixel leaves merge into a stable canopy.
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    pixels.data[offset + 3] = pixels.data[offset + 3] >= LOW_RESOLUTION_ALPHA_THRESHOLD
      ? 255
      : 0;
  }
  dilateTransparentTileColors(
    pixels,
    gridWidth,
    gridHeight,
    targetTileWidth,
    targetTileHeight,
  );
  fillDistantSilhouetteRows(
    pixels,
    gridWidth,
    gridHeight,
    targetTileWidth,
    targetTileHeight,
  );
  return pixels;
}

/** Removes distracting foliage holes while retaining each row's outer silhouette. */
function fillDistantSilhouetteRows(
  image: ImageData,
  gridWidth: number,
  gridHeight: number,
  tileWidth: number,
  tileHeight: number,
): void {
  for (let tileY = 0; tileY < gridHeight; tileY++) {
    for (let tileX = 0; tileX < gridWidth; tileX++) {
      const startX = tileX * tileWidth;
      const startY = tileY * tileHeight;
      for (let localY = 0; localY < tileHeight; localY++) {
        const y = startY + localY;
        let firstCovered = tileWidth;
        let lastCovered = -1;
        for (let localX = 0; localX < tileWidth; localX++) {
          const alpha = image.data[(y * image.width + startX + localX) * 4 + 3];
          if (alpha === 0) continue;
          firstCovered = Math.min(firstCovered, localX);
          lastCovered = localX;
        }
        for (let localX = firstCovered; localX <= lastCovered; localX++) {
          image.data[(y * image.width + startX + localX) * 4 + 3] = 255;
        }
      }
    }
  }
}

/**
 * Supplies hidden edge colors for straight-alpha bilinear sampling. RawTexture
 * preserves RGB under zero alpha; Canvas textures do not, which causes either
 * bright fringes or dark quantization spots at this very small resolution.
 */
function dilateTransparentTileColors(
  image: ImageData,
  gridWidth: number,
  gridHeight: number,
  tileWidth: number,
  tileHeight: number,
): void {
  const source = new Uint8ClampedArray(image.data);
  for (let tileY = 0; tileY < gridHeight; tileY++) {
    for (let tileX = 0; tileX < gridWidth; tileX++) {
      const startX = tileX * tileWidth;
      const startY = tileY * tileHeight;
      for (let localY = 0; localY < tileHeight; localY++) {
        for (let localX = 0; localX < tileWidth; localX++) {
          const x = startX + localX;
          const y = startY + localY;
          const destination = (y * image.width + x) * 4;
          if (source[destination + 3] !== 0) continue;

          let nearest = -1;
          let nearestDistanceSquared = Number.POSITIVE_INFINITY;
          for (let sampleY = 0; sampleY < tileHeight; sampleY++) {
            for (let sampleX = 0; sampleX < tileWidth; sampleX++) {
              const sample = ((startY + sampleY) * image.width + startX + sampleX) * 4;
              if (source[sample + 3] === 0) continue;
              const dx = sampleX - localX;
              const dy = sampleY - localY;
              const distanceSquared = dx * dx + dy * dy;
              if (distanceSquared < nearestDistanceSquared) {
                nearest = sample;
                nearestDistanceSquared = distanceSquared;
              }
            }
          }
          if (nearest >= 0) {
            image.data[destination] = source[nearest];
            image.data[destination + 1] = source[nearest + 1];
            image.data[destination + 2] = source[nearest + 2];
          }
        }
      }
    }
  }
}

function binaryImage(
  pixels: ArrayBufferView,
  width: number,
  height: number,
  context: CanvasRenderingContext2D,
): ImageData {
  const input = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const output = context.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const sourceY = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const source = (sourceY * width + x) * 4;
      const destination = (y * width + x) * 4;
      const alpha = input[source + 3] >= 128 ? 255 : 0;
      output.data[destination] = alpha ? input[source] : 0;
      output.data[destination + 1] = alpha ? input[source + 1] : 0;
      output.data[destination + 2] = alpha ? input[source + 2] : 0;
      output.data[destination + 3] = alpha;
    }
  }
  return output;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
