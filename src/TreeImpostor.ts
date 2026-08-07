import {
  Color4,
  DynamicTexture,
  FreeCamera,
  Material,
  Mesh,
  PBRMaterial,
  RenderTargetTexture,
  Scene,
  SceneLoader,
  Texture,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

export interface TreeImpostorAssets {
  textures: DynamicTexture[];
  gridSize: number;
  resolution: number;
  sourceHeight: number;
  captureDiameter: number;
}

export interface CubeFace {
  normal: Vector3;
  right: Vector3;
  up: Vector3;
}

const TREE_URL = "/assets/realistic-high-poly-tree/Tree.glb";
const ALPHA_URL = "/assets/realistic-high-poly-tree/textures/Eucalyptus_Alpha.png";

export const TREE_IMPOSTOR_FACES: CubeFace[] = [
  { normal: new Vector3(1, 0, 0), right: new Vector3(0, 0, -1), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(-1, 0, 0), right: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(0, 1, 0), right: new Vector3(1, 0, 0), up: new Vector3(0, 0, -1) },
  { normal: new Vector3(0, -1, 0), right: new Vector3(1, 0, 0), up: new Vector3(0, 0, 1) },
  { normal: new Vector3(0, 0, 1), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0) },
  { normal: new Vector3(0, 0, -1), right: new Vector3(-1, 0, 0), up: new Vector3(0, 1, 0) },
];

const sceneAssets = new WeakMap<Scene, Promise<TreeImpostorAssets>>();

/** Captures the high-poly source once and shares the resulting atlases across the scene. */
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
  const atlasSize = gridSize * resolution;
  const maxTextureSize = scene.getEngine().getCaps().maxTextureSize;
  if (atlasSize > maxTextureSize) {
    throw new Error(`Tree impostor atlas ${atlasSize}px exceeds the GPU limit of ${maxTextureSize}px.`);
  }

  console.log(`Tree impostor: capturing ${6 * gridSize * gridSize} views at ${resolution}x${resolution}`);
  const imported = await SceneLoader.ImportMeshAsync("", "", TREE_URL, scene);
  const meshes = imported.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0);
  if (meshes.length === 0) throw new Error("Tree.glb contains no renderable meshes.");
  const root = new TransformNode("treeImpostorCaptureSource", scene);
  imported.meshes.filter((mesh) => !mesh.parent).forEach((mesh) => { mesh.parent = root; });
  // The converted FBX grows along -Y. Put its base at the bottom before capture.
  root.rotation.z = Math.PI;
  await configureMaterials(meshes, scene);
  // ImportMeshAsync can resolve before every material texture is GPU-ready.
  // The interactive demo gets this delay before Capture is clicked; runtime capture must wait explicitly.
  await scene.whenReadyAsync();
  for (let frame = 0; frame < 2; frame++) {
    scene.render();
    await nextFrame();
  }

  root.computeWorldMatrix(true);
  let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  for (const mesh of meshes) {
    mesh.computeWorldMatrix(true);
    const bounds = mesh.getBoundingInfo().boundingBox;
    minimum = Vector3.Minimize(minimum, bounds.minimumWorld);
    maximum = Vector3.Maximize(maximum, bounds.maximumWorld);
  }
  const rawSize = maximum.subtract(minimum);
  const scale = 2 / Math.max(rawSize.x, rawSize.y, rawSize.z);
  root.scaling.setAll(scale);
  root.position.copyFrom(minimum.add(maximum).scale(-0.5 * scale));
  root.computeWorldMatrix(true);
  for (const mesh of meshes) mesh.computeWorldMatrix(true);
  const sourceHeight = rawSize.y * scale;
  const captureDiameter = rawSize.length() * scale * 1.08;

  const canvases = TREE_IMPOSTOR_FACES.map(() => {
    const canvas = document.createElement("canvas");
    canvas.width = atlasSize;
    canvas.height = atlasSize;
    return canvas;
  });
  const camera = new FreeCamera("treeImpostorCaptureCamera", Vector3.Zero(), scene);
  camera.mode = FreeCamera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = 0.01;
  camera.maxZ = captureDiameter * 4;
  camera.orthoLeft = -captureDiameter / 2;
  camera.orthoRight = captureDiameter / 2;
  camera.orthoTop = captureDiameter / 2;
  camera.orthoBottom = -captureDiameter / 2;
  const target = new RenderTargetTexture("treeImpostorCaptureTarget", resolution, scene, false, false);
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
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          const u = gridSize === 1 ? 0 : (x / (gridSize - 1)) * 2 - 1;
          const v = gridSize === 1 ? 0 : (y / (gridSize - 1)) * 2 - 1;
          const direction = face.normal.add(face.right.scale(u)).add(face.up.scale(v)).normalize();
          camera.position.copyFrom(direction.scale(captureDiameter));
          camera.upVector.copyFrom(face.up);
          camera.setTarget(Vector3.Zero());
          scene.activeCamera = camera;
          target.render(true);
          const pixels = await target.readPixels();
          if (!pixels) throw new Error("Tree impostor GPU readback failed.");
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
      `treeImpostorAtlas${index}`,
      { width: atlasSize, height: atlasSize },
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
  root.dispose(false, true);
  imported.meshes.forEach((mesh) => {
    if (!mesh.isDisposed()) mesh.dispose(false, true);
  });
  imported.transformNodes.forEach((node) => {
    if (!node.isDisposed()) node.dispose();
  });
  imported.skeletons.forEach((skeleton) => skeleton.dispose());
  console.log("Tree impostor: capture complete; high-poly source disposed");
  return { textures, gridSize, resolution, sourceHeight, captureDiameter };
}

async function configureMaterials(meshes: Mesh[], scene: Scene): Promise<void> {
  const pendingTextures: Promise<void>[] = [];
  for (const mesh of meshes) {
    const material = mesh.material;
    if (!(material instanceof PBRMaterial)) continue;
    material.unlit = false;
    material.metallic = 0;
    material.roughness = 1;
    if (material.name.toLowerCase().includes("leaves")) {
      let resolveTexture!: () => void;
      let rejectTexture!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveTexture = resolve;
        rejectTexture = reject;
      });
      const alpha = new Texture(
        ALPHA_URL,
        scene,
        false,
        false,
        Texture.BILINEAR_SAMPLINGMODE,
        resolveTexture,
        (message, error) => rejectTexture(error ?? new Error(message ?? "Tree texture failed to load.")),
      );
      pendingTextures.push(alpha.isReady() ? Promise.resolve() : ready);
      alpha.getAlphaFromRGB = true;
      material.opacityTexture = alpha;
      material.transparencyMode = Material.MATERIAL_ALPHATEST;
      material.alphaCutOff = 0.5;
      material.backFaceCulling = false;
    }
  }
  await Promise.all(pendingTextures);
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

function queryNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value >= minimum && value <= maximum ? Math.round(value) : fallback;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
