import {
  Color4,
  DynamicTexture,
  FreeCamera,
  Mesh,
  RenderTargetTexture,
  Scene,
  Texture,
  Vector3,
} from "@babylonjs/core";

export interface ImpostorAssets {
  textures: DynamicTexture[];
  rotationallySymmetric: boolean;
  rotationalSymmetryOrder: number;
  gridWidth: number;
  gridHeight: number;
  /** Kept for the square-grid validation tools. */
  gridSize: number;
  resolution: number;
  resolutionWidth: number;
  resolutionHeight: number;
  sourceHeight: number;
  captureDiameter: number;
  captureWidth: number;
  captureHeight: number;
}

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

  try {
    await scene.whenReadyAsync();
    let captureWidth = definition.captureWidth ?? definition.captureDiameter;
    let captureHeight = definition.captureHeight ?? definition.captureDiameter;
    if (definition.boundsPadding !== undefined) {
      const bounds = sourceDimensions(meshes);
      captureWidth = Math.max(bounds.x, bounds.z) * definition.boundsPadding;
      captureHeight = bounds.y * definition.boundsPadding;
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
    });
    console.log(`${definition.name}: capture complete; procedural source disposed`);
    return assets;
  } finally {
    meshes.forEach((mesh) => mesh.dispose(false, true));
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

function validateSampling(definition: ImpostorDefinition, sampling: ImpostorSampling): void {
  for (const [name, value, limits] of [
    ["horizontalSamples", sampling.horizontalSamples, definition.sampling.horizontalSamples],
    ["verticalSamples", sampling.verticalSamples, definition.sampling.verticalSamples],
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
    onProgress,
  } = options;
  const atlasWidth = gridWidth * resolutionWidth;
  const atlasHeight = gridHeight * resolutionHeight;
  const maxTextureSize = scene.getEngine().getCaps().maxTextureSize;
  if (atlasWidth > maxTextureSize || atlasHeight > maxTextureSize) {
    throw new Error(
      `${name} atlas ${atlasWidth}x${atlasHeight}px exceeds the GPU limit of ${maxTextureSize}px.`,
    );
  }
  console.log(
    `${name}: capturing ${faces.length * gridWidth * gridHeight} views ` +
    `(${gridWidth}x${gridHeight} per face) at ${resolutionWidth}x${resolutionHeight}`,
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
  const target = new RenderTargetTexture(
    `${name}CaptureTarget`,
    { width: resolutionWidth, height: resolutionHeight },
    scene,
    false,
    false,
  );
  target.clearColor = new Color4(0, 0, 0, 0);
  target.renderList = meshes;
  target.activeCamera = camera;
  target.ignoreCameraViewport = true;
  target.samples = 1;
  const activeCamera = scene.activeCamera;
  const total = faces.length * gridWidth * gridHeight;
  let completed = 0;

  try {
    for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
      const face = faces[faceIndex];
      const context = canvases[faceIndex].getContext("2d", { alpha: true })!;
      const verticalSpan = Math.abs(face.normal.y) > 0.5 ? captureWidth : captureHeight;
      camera.orthoTop = verticalSpan / 2;
      camera.orthoBottom = -verticalSpan / 2;
      for (let y = 0; y < gridHeight; y++) {
        for (let x = 0; x < gridWidth; x++) {
          const u = gridWidth === 1 ? 0 : (x / (gridWidth - 1)) * 2 - 1;
          const v = gridHeight === 1 ? 0 : (y / (gridHeight - 1)) * 2 - 1;
          const direction = face.normal.add(face.right.scale(u)).add(face.up.scale(v)).normalize();
          camera.position.copyFrom(direction.scale(captureDiameter));
          camera.upVector.copyFrom(face.up);
          camera.setTarget(Vector3.Zero());
          scene.activeCamera = camera;
          target.render(true);
          const pixels = await target.readPixels();
          if (!pixels) throw new Error(`${name} GPU readback failed.`);
          context.putImageData(
            binaryImage(pixels, resolutionWidth, resolutionHeight, context),
            x * resolutionWidth,
            y * resolutionHeight,
          );
          completed++;
          onProgress?.(completed, total, faceIndex, x, y);
          await nextFrame();
        }
      }
    }
  } finally {
    scene.activeCamera = activeCamera;
    target.dispose();
    camera.dispose();
  }

  const textures = canvases.map((canvas, index) => {
    const texture = new DynamicTexture(
      `${name}Atlas${index}`,
      { width: atlasWidth, height: atlasHeight },
      scene,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
    );
    texture.gammaSpace = false;
    texture.getContext().drawImage(canvas, 0, 0);
    texture.hasAlpha = true;
    texture.update(false);
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    return texture;
  });
  return {
    textures,
    rotationallySymmetric,
    rotationalSymmetryOrder,
    gridWidth,
    gridHeight,
    gridSize: gridWidth,
    resolution: resolutionHeight,
    resolutionWidth,
    resolutionHeight,
    sourceHeight,
    captureDiameter,
    captureWidth,
    captureHeight,
  };
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
