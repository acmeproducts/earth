import {
  Color4,
  DynamicTexture,
  FreeCamera,
  Mesh,
  RenderTargetTexture,
  Scene,
  Texture,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import {
  createProceduralTree,
  PROCEDURAL_TREE_CAPTURE_DIAMETER,
  PROCEDURAL_TREE_SOURCE_HEIGHT,
} from "./ProceduralTree";

export interface ImpostorAssets {
  textures: DynamicTexture[];
  rotationallySymmetric: boolean;
  rotationalSymmetryOrder: number;
  gridWidth: number;
  gridHeight: number;
  /** Square-grid compatibility for the tree capture validation tools. */
  gridSize: number;
  resolution: number;
  resolutionWidth: number;
  resolutionHeight: number;
  sourceHeight: number;
  captureDiameter: number;
  captureWidth: number;
  captureHeight: number;
}

export type TreeImpostorAssets = ImpostorAssets;

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
}

export interface CubeFace {
  normal: Vector3;
  right: Vector3;
  up: Vector3;
}

export const TREE_IMPOSTOR_FACES: CubeFace[] = [
  { normal: new Vector3(1, 0, 0), right: new Vector3(0, 0, -1), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(-1, 0, 0), right: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(0, 1, 0), right: new Vector3(1, 0, 0), up: new Vector3(0, 0, -1) },
  { normal: new Vector3(0, 0, 1), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(0, 0, -1), right: new Vector3(-1, 0, 0), up: new Vector3(0, 1, 0) },
];

/** One side and the top are sufficient for sources symmetric around the Y axis. */
export const SYMMETRIC_IMPOSTOR_FACES: CubeFace[] = [
  TREE_IMPOSTOR_FACES[0],
  TREE_IMPOSTOR_FACES[2],
];

const sceneAssets = new WeakMap<Scene, Map<string, Promise<TreeImpostorAssets>>>();

/** Shares one tree atlas capture per scene and capture-attribute combination. */
export function getTreeImpostorAssets(
  scene: Scene,
  horizontalSamples = queryNumber("tree-impostor-x-samples", 10, 1, 16),
  verticalSamples = queryNumber("tree-impostor-y-samples", 5, 1, 10),
  resolutionHeight = queryNumber("tree-impostor-resolution", 500, 64, 1024),
): Promise<TreeImpostorAssets> {
  let cache = sceneAssets.get(scene);
  if (!cache) {
    cache = new Map();
    sceneAssets.set(scene, cache);
  }
  const key = impostorAttributeKey(horizontalSamples, verticalSamples, resolutionHeight);
  const existing = cache.get(key);
  if (existing) return existing;
  const capture = captureTree(
    scene,
    horizontalSamples,
    verticalSamples,
    resolutionHeight,
  );
  cache.set(key, capture);
  capture.catch(() => {
    if (cache.get(key) === capture) cache.delete(key);
  });
  return capture;
}

export function impostorAttributeKey(...attributes: number[]): string {
  return attributes.map((attribute) => `${attribute}`).join(":");
}

async function captureTree(
  scene: Scene,
  horizontalSamples: number,
  verticalSamples: number,
  resolutionHeight: number,
): Promise<TreeImpostorAssets> {
  const source = createProceduralTree(scene);
  await scene.whenReadyAsync();
  source.refreshBoundingInfo();
  const bounds = source.getBoundingInfo().boundingBox;
  const size = bounds.maximumWorld.subtract(bounds.minimumWorld);
  const captureWidth = Math.max(size.x, size.z) * 1.04;
  const captureHeight = size.y * 1.04;
  const resolutionWidth = Math.max(64, Math.round(
    resolutionHeight * captureWidth / captureHeight,
  ));

  try {
    const assets = await captureImpostorAtlases(scene, {
      name: "treeImpostor",
      meshes: [source],
      gridWidth: horizontalSamples,
      gridHeight: verticalSamples,
      resolution: resolutionHeight,
      resolutionWidth,
      resolutionHeight,
      sourceHeight: PROCEDURAL_TREE_SOURCE_HEIGHT,
      captureDiameter: PROCEDURAL_TREE_CAPTURE_DIAMETER,
      captureWidth,
      captureHeight,
    });
    console.log("Tree impostor: capture complete; procedural source disposed");
    return assets;
  } finally {
    source.dispose(false, true);
  }
}

/** Builds the original procedural geometry at the requested rendered height. */
export async function createTreeModels(
  scene: Scene,
  renderHeight: number,
): Promise<Mesh[]> {
  const tree = createProceduralTree(scene, {
    name: "treeModels",
    liveLighting: true,
  });
  const positions = tree.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) throw new Error("Procedural tree has no position data.");

  const renderScale = renderHeight / PROCEDURAL_TREE_SOURCE_HEIGHT;
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] *= renderScale;
    positions[index + 1] = positions[index + 1] * renderScale + renderHeight / 2;
    positions[index + 2] *= renderScale;
  }
  tree.setVerticesData(VertexBuffer.PositionKind, positions);
  tree.refreshBoundingInfo();
  return [tree];
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
    faces = TREE_IMPOSTOR_FACES,
    rotationallySymmetric = false,
    rotationalSymmetryOrder = 0,
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

export function queryNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value >= minimum && value <= maximum ? Math.round(value) : fallback;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
