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
  gridWidth: number;
  gridHeight: number;
  /** Square-grid compatibility for the tree capture validation tools. */
  gridSize: number;
  resolution: number;
  sourceHeight: number;
  captureDiameter: number;
}

export type TreeImpostorAssets = ImpostorAssets;

export interface ImpostorCaptureOptions {
  name: string;
  meshes: Mesh[];
  gridWidth: number;
  gridHeight: number;
  resolution: number;
  sourceHeight: number;
  captureDiameter: number;
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
  { normal: new Vector3(0, -1, 0), right: new Vector3(1, 0, 0), up: new Vector3(0, 0, 1) },
  { normal: new Vector3(0, 0, 1), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(0, 0, -1), right: new Vector3(-1, 0, 0), up: new Vector3(0, 1, 0) },
];

const sceneAssets = new WeakMap<Scene, Promise<TreeImpostorAssets>>();

/** Generates and captures the tree once, then shares its atlases across the scene. */
export function getTreeImpostorAssets(
  scene: Scene,
  gridSize = queryNumber("impostor-grid", 10, 1, 16),
  resolution = queryNumber("impostor-resolution", 500, 64, 1024),
): Promise<TreeImpostorAssets> {
  const existing = sceneAssets.get(scene);
  if (existing) return existing;
  const capture = captureTree(scene, gridSize, resolution);
  sceneAssets.set(scene, capture);
  return capture;
}

async function captureTree(scene: Scene, gridSize: number, resolution: number): Promise<TreeImpostorAssets> {
  const source = createProceduralTree(scene);
  await scene.whenReadyAsync();

  try {
    const assets = await captureImpostorAtlases(scene, {
      name: "treeImpostor",
      meshes: [source],
      gridWidth: gridSize,
      gridHeight: gridSize,
      resolution,
      sourceHeight: PROCEDURAL_TREE_SOURCE_HEIGHT,
      captureDiameter: PROCEDURAL_TREE_CAPTURE_DIAMETER,
    });
    console.log("Tree impostor: capture complete; procedural source disposed");
    return assets;
  } finally {
    source.dispose(false, true);
  }
}

/** Builds the original procedural geometry at the requested rendered height. */
export async function createTreeModels(scene: Scene, renderHeight: number): Promise<Mesh[]> {
  const tree = createProceduralTree(scene, { name: "treeModels", liveLighting: true });
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

/** Captures any prepared, origin-centered source into six directional atlases. */
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
    sourceHeight,
    captureDiameter,
  } = options;
  const atlasWidth = gridWidth * resolution;
  const atlasHeight = gridHeight * resolution;
  const maxTextureSize = scene.getEngine().getCaps().maxTextureSize;
  if (atlasWidth > maxTextureSize || atlasHeight > maxTextureSize) {
    throw new Error(
      `${name} atlas ${atlasWidth}x${atlasHeight}px exceeds the GPU limit of ${maxTextureSize}px.`,
    );
  }
  console.log(
    `${name}: capturing ${6 * gridWidth * gridHeight} views ` +
    `(${gridWidth}x${gridHeight} per face) at ${resolution}x${resolution}`,
  );

  const canvases = TREE_IMPOSTOR_FACES.map(() => {
    const canvas = document.createElement("canvas");
    canvas.width = atlasWidth;
    canvas.height = atlasHeight;
    return canvas;
  });
  const camera = new FreeCamera(`${name}CaptureCamera`, Vector3.Zero(), scene);
  camera.mode = FreeCamera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = 0.01;
  camera.maxZ = captureDiameter * 4;
  camera.orthoLeft = -captureDiameter / 2;
  camera.orthoRight = captureDiameter / 2;
  camera.orthoTop = captureDiameter / 2;
  camera.orthoBottom = -captureDiameter / 2;
  const target = new RenderTargetTexture(`${name}CaptureTarget`, resolution, scene, false, false);
  target.clearColor = new Color4(0, 0, 0, 0);
  target.renderList = meshes;
  target.activeCamera = camera;
  target.ignoreCameraViewport = true;
  target.samples = 1;
  const activeCamera = scene.activeCamera;

  try {
    for (let faceIndex = 0; faceIndex < TREE_IMPOSTOR_FACES.length; faceIndex++) {
      const face = TREE_IMPOSTOR_FACES[faceIndex];
      const context = canvases[faceIndex].getContext("2d", { alpha: true })!;
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
          context.putImageData(binaryImage(pixels, resolution, context), x * resolution, y * resolution);
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
    gridWidth,
    gridHeight,
    gridSize: gridWidth,
    resolution,
    sourceHeight,
    captureDiameter,
  };
}

function binaryImage(pixels: ArrayBufferView, size: number, context: CanvasRenderingContext2D): ImageData {
  const input = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const output = context.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const sourceY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const source = (sourceY * size + x) * 4;
      const destination = (y * size + x) * 4;
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
