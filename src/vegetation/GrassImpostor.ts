import { createPlantMesh, appendBladeIndices } from "./PlantGeometry";
import {
  Color3,
  Mesh,
  Scene,
} from "@babylonjs/core";
import {
  AXISYMMETRIC_IMPOSTOR_FACES,
  createImpostorAssetProvider,
  ImpostorAssetLease,
  ImpostorVariant,
} from "../rendering/Impostor";
import { createVertexColorCaptureMaterial, scaleVertexColorModel } from "../procedural/ProceduralCaptureMaterial";
import { createSeededRandom } from "../core/Random";
import { smoothstep } from "../core/MathUtils";

const SOURCE_HEIGHT = 0.85;
// Allow the broad, low fringe to fit inside the capture without clipping.
const CAPTURE_DIAMETER = 5.4;
/** Nominal blade radius of the clump, in source units. */
const CLUMP_RADIUS = 1.95;
const CLUMP_EDGE_RADIUS_SCALE_MINIMUM = 0.78;
const CLUMP_EDGE_RADIUS_SCALE_SPAN = 0.44;
const CLUMP_EDGE_RADIUS_SCALE_MAXIMUM =
  CLUMP_EDGE_RADIUS_SCALE_MINIMUM + CLUMP_EDGE_RADIUS_SCALE_SPAN;

export function grassRenderedCaptureSize(renderHeight: number): number {
  return CAPTURE_DIAMETER * renderHeight / SOURCE_HEIGHT;
}

/** How far the clump's near edge stands in front of its center once rendered. */
export function grassRenderedClumpRadius(renderHeight: number): number {
  return CLUMP_RADIUS * CLUMP_EDGE_RADIUS_SCALE_MAXIMUM * renderHeight / SOURCE_HEIGHT;
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
    resolution: { default: 192, minimum: 48, maximum: 512 },
  },
});

export function acquireGrassImpostorAssets(
  scene: Scene,
  variant: ImpostorVariant,
): Promise<ImpostorAssetLease> {
  return grassImpostors.acquireAssets(scene, undefined, variant);
}

/** Builds a broad, sparse clump with a low fringe for overlapping neighbours. */
function createGrassSource(scene: Scene, liveLighting = false, seed = 0x47524153): Mesh {
  const random = createSeededRandom(seed);
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const segments = 5;
  // Blade density is baked into the atlas, so it does not increase field draw cost.
  const bladeCount = 1600;
  const symmetryOrder = 8;
  const sectorAngle = Math.PI * 2 / symmetryOrder;

  for (let blade = 0; blade < bladeCount / symmetryOrder; blade++) {
    const baseAngle = random() * sectorAngle;
    // A broad per-blade boundary makes density taper naturally instead of
    // ending at the same circular outline on every captured clump.
    const edgeRadius = CLUMP_RADIUS * (
      CLUMP_EDGE_RADIUS_SCALE_MINIMUM + random() * CLUMP_EDGE_RADIUS_SCALE_SPAN
    );
    const radius = Math.sqrt(random()) * edgeRadius;
    const bladeAngle = random() * Math.PI * 2;
    const bendAngle = baseAngle + (random() - 0.5) * 1.8;
    // Keep height near the centre, then descend to 8% at the irregular perimeter.
    // Overlapping fringes fill one another without stacking tall, dense rims.
    const edgeScale = 1 - 0.92 * smoothstep(0.12, 1, radius / edgeRadius);
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

      appendBladeIndices(indices, vertexStart, segments);
    }
  }

  const grass = createPlantMesh(scene, "grassImpostorProceduralSource", positions, indices, colors);

  const material = createVertexColorCaptureMaterial(
    scene,
    "grassImpostorSourceMaterial",
    liveLighting,
  );
  if (!liveLighting) {
    // Bake the height-based crown light into the atlas so the impostor shows
    // the same darker fringe and brighter tips as the live model. The capture
    // source is centred on the origin, so its base sits half a height below.
    material.setFloat("modelHeight", SOURCE_HEIGHT);
    material.setFloat("modelBaseY", -SOURCE_HEIGHT / 2);
    material.setFloat("bakeCrownLight", 1);
  }
  grass.material = material;
  return grass;
}

/** Builds the captured procedural clump as live geometry for nearby instances. */
export function createGrassModel(scene: Scene, renderHeight: number, seed?: number): Mesh {
  const grass = createGrassSource(scene, true, seed);
  grass.name = "grassModels";
  scaleVertexColorModel(grass, renderHeight, SOURCE_HEIGHT);
  return grass;
}
