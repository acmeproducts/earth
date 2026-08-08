import {
  Color3,
  Mesh,
  Scene,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import {
  captureImpostorAtlases,
  ImpostorAssets,
  impostorAttributeKey,
  queryNumber,
  SYMMETRIC_IMPOSTOR_FACES,
} from "./TreeImpostor";
import { createVertexColorCaptureMaterial } from "./ProceduralCaptureMaterial";

export type GrassImpostorAssets = ImpostorAssets;

const SOURCE_HEIGHT = 0.6;
const CAPTURE_DIAMETER = 7.3;
const GRASS_PALETTES: ReadonlyArray<readonly [Color3, Color3]> = [
  [new Color3(0.14, 0.31, 0.055), new Color3(0.4, 0.7, 0.14)],
  [new Color3(0.18, 0.37, 0.065), new Color3(0.5, 0.78, 0.18)],
  [new Color3(0.12, 0.28, 0.075), new Color3(0.34, 0.63, 0.17)],
  [new Color3(0.22, 0.4, 0.065), new Color3(0.58, 0.81, 0.18)],
  [new Color3(0.32, 0.3, 0.09), new Color3(0.72, 0.65, 0.22)],
];
const sceneAssets = new WeakMap<Scene, Map<string, Promise<GrassImpostorAssets>>>();

/** Shares one grass atlas capture per scene and capture-attribute combination. */
export function getGrassImpostorAssets(
  scene: Scene,
  horizontalSamples = queryNumber("grass-impostor-x-samples", 8, 1, 24),
  verticalSamples = queryNumber("grass-impostor-y-samples", 8, 1, 12),
  resolution = queryNumber("grass-impostor-resolution", 128, 48, 512),
): Promise<GrassImpostorAssets> {
  let cache = sceneAssets.get(scene);
  if (!cache) {
    cache = new Map();
    sceneAssets.set(scene, cache);
  }
  const key = impostorAttributeKey(horizontalSamples, verticalSamples, resolution);
  const existing = cache.get(key);
  if (existing) return existing;

  const capture = captureGrass(scene, horizontalSamples, verticalSamples, resolution);
  cache.set(key, capture);
  capture.catch(() => {
    if (cache.get(key) === capture) cache.delete(key);
  });
  return capture;
}

async function captureGrass(
  scene: Scene,
  horizontalSamples: number,
  verticalSamples: number,
  resolution: number,
): Promise<GrassImpostorAssets> {
  const source = createGrassSource(scene);
  await scene.whenReadyAsync();

  try {
    const assets = await captureImpostorAtlases(scene, {
      name: "grassImpostor",
      meshes: [source],
      gridWidth: horizontalSamples,
      gridHeight: verticalSamples,
      resolution,
      sourceHeight: SOURCE_HEIGHT,
      captureDiameter: CAPTURE_DIAMETER,
      faces: SYMMETRIC_IMPOSTOR_FACES,
      rotationallySymmetric: true,
      rotationalSymmetryOrder: 4,
    });
    console.log("Grass impostor: capture complete; procedural source disposed");
    return assets;
  } finally {
    source.dispose(false, true);
  }
}

/** Builds a dense clump from tapered, curved blade strips without external assets. */
function createGrassSource(scene: Scene, liveLighting = false): Mesh {
  const random = mulberry32(0x47524153);
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const segments = 5;
  // Blade density is baked into the atlas, so it does not increase field draw cost.
  const bladeCount = 2800;
  const symmetryOrder = 8;
  const sectorAngle = Math.PI * 2 / symmetryOrder;

  for (let blade = 0; blade < bladeCount / symmetryOrder; blade++) {
    const baseAngle = random() * sectorAngle;
    const edgeRadius = 2.5 + (random() - 0.5) * 0.38;
    const radius = Math.sqrt(random()) * edgeRadius;
    const bladeAngle = random() * Math.PI * 2;
    const bendAngle = baseAngle + (random() - 0.5) * 1.8;
    const edgeScale = 1 - 0.24 * Math.pow(radius / edgeRadius, 2);
    const height = (0.18 + Math.pow(random(), 0.7) * 0.42) * edgeScale;
    const bend = (0.035 + random() * 0.3) * height;
    const width = 0.012 + Math.pow(random(), 1.7) * 0.052;
    const paletteRoll = random();
    const paletteIndex = paletteRoll < 0.12
      ? GRASS_PALETTES.length - 1
      : Math.floor(random() * (GRASS_PALETTES.length - 1));
    const [baseColor, tipColor] = GRASS_PALETTES[paletteIndex];
    const brightness = (0.86 + random() * 0.34) * 0.9;
    const colorMix = 0.58 + random() * 0.28;
    const red = Math.min(1, (baseColor.r + (tipColor.r - baseColor.r) * colorMix) * brightness);
    const green = Math.min(1, (baseColor.g + (tipColor.g - baseColor.g) * colorMix) * brightness);
    const blue = Math.min(1, (baseColor.b + (tipColor.b - baseColor.b) * colorMix) * brightness);

    for (let copy = 0; copy < symmetryOrder; copy++) {
      const rotation = copy * sectorAngle;
      const rotatedBaseAngle = baseAngle + rotation;
      const rotatedBladeAngle = bladeAngle + rotation;
      const rotatedBendAngle = bendAngle + rotation;
      const baseX = Math.cos(rotatedBaseAngle) * radius;
      const baseZ = Math.sin(rotatedBaseAngle) * radius;
      const sideX = Math.cos(rotatedBladeAngle);
      const sideZ = Math.sin(rotatedBladeAngle);
      const vertexStart = positions.length / 3;

      for (let segment = 0; segment <= segments; segment++) {
        const t = segment / segments;
        const taper = Math.max(0.04, 1 - t * t);
        const curve = bend * t * t;
        const centerX = baseX + Math.cos(rotatedBendAngle) * curve;
        const centerZ = baseZ + Math.sin(rotatedBendAngle) * curve;
        const centerY = -SOURCE_HEIGHT / 2 + height * t;
        const halfWidth = width * taper;

        positions.push(
          centerX - sideX * halfWidth,
          centerY,
          centerZ - sideZ * halfWidth,
          centerX + sideX * halfWidth,
          centerY,
          centerZ + sideZ * halfWidth,
        );
        colors.push(red, green, blue, 1, red, green, blue, 1);
      }

      for (let segment = 0; segment < segments; segment++) {
        const left = vertexStart + segment * 2;
        indices.push(left, left + 2, left + 1, left + 1, left + 2, left + 3);
      }
    }
  }

  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.colors = colors;

  const grass = new Mesh("grassImpostorProceduralSource", scene);
  data.applyToMesh(grass);
  grass.isPickable = false;
  grass.useVertexColors = true;

  const material = createVertexColorCaptureMaterial(
    scene,
    "grassImpostorSourceMaterial",
    liveLighting,
  );
  grass.material = material;
  return grass;
}

/** Builds the original procedural geometry at the requested rendered height. */
export function createGrassModel(scene: Scene, renderHeight: number): Mesh {
  const grass = createGrassSource(scene, true);
  grass.name = "grassModels";
  scaleSourceToHeight(grass, renderHeight, SOURCE_HEIGHT);
  return grass;
}

function scaleSourceToHeight(mesh: Mesh, renderHeight: number, sourceHeight: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) throw new Error(`${mesh.name} has no position data.`);

  const scale = renderHeight / sourceHeight;
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] *= scale;
    positions[index + 1] = positions[index + 1] * scale + renderHeight / 2;
    positions[index + 2] *= scale;
  }
  mesh.setVerticesData(VertexBuffer.PositionKind, positions);
  mesh.refreshBoundingInfo();
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
