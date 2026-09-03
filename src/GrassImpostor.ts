import {
  Color3,
  Mesh,
  Scene,
  ShaderMaterial,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import {
  AXISYMMETRIC_IMPOSTOR_FACES,
  createImpostorAssetProvider,
  ImpostorAssetLease,
  ImpostorVariant,
} from "./Impostor";
import { createVertexColorCaptureMaterial } from "./procedural/ProceduralCaptureMaterial";
import { createSeededRandom } from "./Random";

const SOURCE_HEIGHT = 0.85;
// Keeping the patch compact and relatively tall lets its blades use the square
// capture efficiently instead of collapsing into a thin strip of pixels.
const CAPTURE_DIAMETER = 3.8;
/** Nominal blade radius of the clump, in source units. */
const CLUMP_RADIUS = 1.3;

export function grassRenderedCaptureSize(renderHeight: number): number {
  return CAPTURE_DIAMETER * renderHeight / SOURCE_HEIGHT;
}

/** How far the clump's near edge stands in front of its center once rendered. */
export function grassRenderedClumpRadius(renderHeight: number): number {
  return CLUMP_RADIUS * renderHeight / SOURCE_HEIGHT;
}
// Keep grass in the same cool-green family as the tree canopy, but bias the
// blades toward muted olive tones. Highly green tips become neon once direct
// sun and the local ground multiplier are both applied.
const GRASS_PALETTES: ReadonlyArray<readonly [Color3, Color3]> = [
  [new Color3(0.07, 0.18, 0.07), new Color3(0.22, 0.42, 0.14)],
  [new Color3(0.09, 0.22, 0.07), new Color3(0.3, 0.49, 0.15)],
  [new Color3(0.12, 0.25, 0.08), new Color3(0.38, 0.54, 0.17)],
  [new Color3(0.15, 0.24, 0.07), new Color3(0.43, 0.51, 0.15)],
];
const grassImpostors = createImpostorAssetProvider({
  name: "grassImpostor",
  queryPrefix: "grass-impostor",
  createSource: (scene, variant) => createGrassSource(scene, false, variant.seed),
  sourceHeight: SOURCE_HEIGHT,
  captureDiameter: CAPTURE_DIAMETER,
  faces: AXISYMMETRIC_IMPOSTOR_FACES,
  rotationallySymmetric: true,
  rotationalSymmetryOrder: 4,
  upperHemisphereOnly: true,
  sampling: {
    horizontalSamples: { default: 5, minimum: 1, maximum: 24 },
    verticalSamples: { default: 5, minimum: 1, maximum: 20 },
    resolution: { default: 128, minimum: 48, maximum: 512 },
  },
});

export function acquireGrassImpostorAssets(
  scene: Scene,
  variant: ImpostorVariant,
): Promise<ImpostorAssetLease> {
  return grassImpostors.acquireAssets(scene, undefined, variant);
}

/** Builds a dense clump from tapered, curved blade strips without external assets. */
function createGrassSource(scene: Scene, liveLighting = false, seed = 0x47524153): Mesh {
  const random = createSeededRandom(seed);
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
    const edgeRadius = CLUMP_RADIUS + (random() - 0.5) * 0.22;
    const radius = Math.sqrt(random()) * edgeRadius;
    const bladeAngle = random() * Math.PI * 2;
    const bendAngle = baseAngle + (random() - 0.5) * 1.8;
    const edgeScale = 1 - 0.24 * Math.pow(radius / edgeRadius, 2);
    const height = (0.28 + Math.pow(random(), 0.7) * 0.57) * edgeScale;
    const bend = (0.035 + random() * 0.3) * height;
    const width = 0.012 + Math.pow(random(), 1.7) * 0.052;
    const paletteRoll = random();
    const paletteIndex = paletteRoll < 0.12
      ? GRASS_PALETTES.length - 1
      : Math.floor(random() * (GRASS_PALETTES.length - 1));
    const [baseColor, tipColor] = GRASS_PALETTES[paletteIndex];
    // A restrained brightness keeps dense patches visually grounded.
    const brightness = (0.86 + random() * 0.34) * 0.76;
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

/** Builds the captured procedural clump as live geometry for nearby instances. */
export function createGrassModel(scene: Scene, renderHeight: number, seed?: number): Mesh {
  const grass = createGrassSource(scene, true, seed);
  grass.name = "grassModels";
  scaleSourceToHeight(grass, renderHeight, SOURCE_HEIGHT);
  if (grass.material instanceof ShaderMaterial) {
    grass.material.setFloat("modelHeight", renderHeight);
  }
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
