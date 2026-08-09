import {
  Color3,
  Mesh,
  Scene,
  VertexData,
} from "@babylonjs/core";
import {
  AXISYMMETRIC_IMPOSTOR_FACES,
  createImpostorAssetProvider,
  ImpostorAssets,
} from "./Impostor";
import { createVertexColorCaptureMaterial } from "./ProceduralCaptureMaterial";

export type GrassImpostorAssets = ImpostorAssets;

const SOURCE_HEIGHT = 0.6;
const CAPTURE_DIAMETER = 7.3;
// Keep grass in the same cool-green family as the tree canopy, with a small
// lift so it remains distinguishable at ground level.
const GRASS_PALETTES: ReadonlyArray<readonly [Color3, Color3]> = [
  [new Color3(0.05, 0.202, 0.062), new Color3(0.202, 0.493, 0.106)],
  [new Color3(0.073, 0.258, 0.056), new Color3(0.302, 0.594, 0.118)],
  [new Color3(0.101, 0.291, 0.062), new Color3(0.392, 0.661, 0.134)],
  [new Color3(0.134, 0.28, 0.05), new Color3(0.482, 0.627, 0.118)],
];
const grassImpostors = createImpostorAssetProvider({
  name: "grassImpostor",
  queryPrefix: "grass-impostor",
  createSource: (scene) => createGrassSource(scene),
  sourceHeight: SOURCE_HEIGHT,
  captureDiameter: CAPTURE_DIAMETER,
  faces: AXISYMMETRIC_IMPOSTOR_FACES,
  rotationallySymmetric: true,
  rotationalSymmetryOrder: 4,
  sampling: {
    horizontalSamples: { default: 8, minimum: 1, maximum: 24 },
    verticalSamples: { default: 8, minimum: 1, maximum: 12 },
    resolution: { default: 128, minimum: 48, maximum: 512 },
  },
});

/** Shares one grass atlas capture per scene and capture-attribute combination. */
export function getGrassImpostorAssets(
  scene: Scene,
  horizontalSamples = grassImpostors.getDefaultSampling().horizontalSamples,
  verticalSamples = grassImpostors.getDefaultSampling().verticalSamples,
  resolution = grassImpostors.getDefaultSampling().resolution,
): Promise<GrassImpostorAssets> {
  return grassImpostors.getAssets(scene, {
    horizontalSamples,
    verticalSamples,
    resolution,
  });
}

/** Builds a dense clump from tapered, curved blade strips without external assets. */
function createGrassSource(scene: Scene): Mesh {
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
    false,
  );
  grass.material = material;
  return grass;
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
