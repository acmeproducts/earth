import {
  Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import {
  AXISYMMETRIC_IMPOSTOR_FACES,
  createImpostorAssetProvider,
  type ImpostorAssetLease,
  type ImpostorVariant,
} from "../rendering/Impostor";
import { createVertexColorCaptureMaterial } from "../procedural/ProceduralCaptureMaterial";
import { createSeededRandom } from "../core/Random";

const SOURCE_HEIGHT = 0.62;
const CAPTURE_DIAMETER = 6.2;
const STONE_COUNT = 480;
const STONE_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [0.38, 0.39, 0.39],
  [0.44, 0.44, 0.43],
  [0.33, 0.35, 0.36],
  [0.47, 0.46, 0.44],
  [0.29, 0.31, 0.31],
  [0.52, 0.53, 0.51],
  [0.36, 0.38, 0.41],
  [0.43, 0.40, 0.37],
];

export function rockyBeachRenderedCaptureSize(renderHeight: number): number {
  return CAPTURE_DIAMETER * renderHeight / SOURCE_HEIGHT;
}

const rockyBeachImpostors = createImpostorAssetProvider({
  name: "rockyBeachImpostor",
  queryPrefix: "rocky-beach-impostor",
  snowfall: true,
  createSource: (scene, variant) => createRockyBeachSource(scene, false, variant.seed),
  sourceHeight: SOURCE_HEIGHT,
  captureDiameter: CAPTURE_DIAMETER,
  faces: AXISYMMETRIC_IMPOSTOR_FACES,
  rotationallySymmetric: true,
  rotationalSymmetryOrder: 4,
  upperHemisphereOnly: true,
  sampling: {
    horizontalSamples: { default: 5, minimum: 1, maximum: 16 },
    verticalSamples: { default: 5, minimum: 1, maximum: 12 },
    resolution: { default: 192, minimum: 48, maximum: 512 },
  },
});

export function acquireRockyBeachImpostorAssets(
  scene: Scene,
  variant: ImpostorVariant,
): Promise<ImpostorAssetLease> {
  return rockyBeachImpostors.acquireAssets(scene, undefined, variant);
}

/** Builds a dense, low pebble-and-stone patch to bake into one atlas card. */
function createRockyBeachSource(
  scene: Scene,
  liveLighting = false,
  seed = 0x524f434b,
): Mesh {
  const random = createSeededRandom(seed);
  const base = MeshBuilder.CreateIcoSphere(
    "rockyBeachStoneTemplate",
    { radius: 1, subdivisions: 1, flat: false },
    scene,
  );
  const basePositions = base.getVerticesData(VertexBuffer.PositionKind)!;
  const baseIndices = base.getIndices()!;
  base.dispose(false, true);

  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const patchPhase = random() * Math.PI * 2;
  const patchSize = 0.8 + random() * 0.3;
  const patchBrightness = 0.9 + random() * 0.2;
  const stoneCount = Math.round(STONE_COUNT * (0.85 + random() * 0.3));
  for (let stone = 0; stone < stoneCount; stone++) {
    const angle = random() * Math.PI * 2;
    // A dense center and sparse, lobed fringe hide the repeated card footprint.
    const edge = 0.83 + 0.1 * Math.sin(angle * 3 + patchPhase)
      + 0.07 * Math.sin(angle * 5 - patchPhase * 1.7);
    const radius = Math.pow(random(), 0.7) * (CAPTURE_DIAMETER * 0.44) * edge;
    const centerX = Math.cos(angle) * radius;
    const centerZ = Math.sin(angle) * radius;
    const large = random() < 0.035;
    const stoneRadius = large
      ? 0.12 + random() * 0.13
      : 0.025 + Math.pow(random(), 1.65) * 0.09;
    const scaleX = stoneRadius * patchSize * (0.65 + random() * 0.85);
    const scaleY = stoneRadius * patchSize * (0.28 + random() * 0.55);
    const scaleZ = stoneRadius * patchSize * (0.65 + random() * 0.85);
    const yaw = random() * Math.PI * 2;
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const vertexOffset = positions.length / 3;
    const palette = STONE_COLORS[Math.floor(random() * STONE_COLORS.length)];
    const brightness = (0.78 + random() * 0.4) * patchBrightness;
    const irregularity = 0.04 + random() * 0.16;
    const leanX = (random() - 0.5) * 0.35;
    const leanZ = (random() - 0.5) * 0.35;

    for (let index = 0; index < basePositions.length; index += 3) {
      const sourceX = basePositions[index];
      const sourceY = basePositions[index + 1];
      const sourceZ = basePositions[index + 2];
      const localX = (sourceX + sourceY * leanX) * scaleX;
      const localZ = (sourceZ + sourceY * leanZ) * scaleZ;
      const warp = 1 + irregularity * Math.sin(sourceX * 5.1 + sourceZ * 7.3 + stone);
      positions.push(
        centerX + (localX * cosine - localZ * sine) * warp,
        -SOURCE_HEIGHT / 2 + scaleY * (0.48 + sourceY * 0.72),
        centerZ + (localX * sine + localZ * cosine) * warp,
      );
      // Broad strata, fine crystalline flecks and an occasional pale seam are
      // baked into the atlas. They remain visible after the individual pebble
      // normals have been flattened by the impostor renderer.
      const strata = Math.sin(
        (centerX + sourceX * scaleX) * 8.7 +
        (centerZ + sourceZ * scaleZ) * 5.3 + stone * 0.71,
      );
      const fleck = Math.sin(sourceX * 31.7 + sourceY * 23.1 + sourceZ * 37.9 + stone * 2.17);
      const mineral = strata * 0.035 + fleck * 0.02;
      const upward = sourceY * 0.08;
      const damp = sourceY < -0.12 ? 0.91 : 1;
      colors.push(
        Math.min(1, palette[0] * (brightness + upward + mineral) * damp),
        Math.min(1, palette[1] * (brightness + upward + mineral * 0.86) * damp),
        Math.min(1, palette[2] * (brightness + upward + mineral * 0.64) * damp),
        1,
      );
    }
    for (const index of baseIndices) indices.push(vertexOffset + index);
  }

  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.colors = colors;
  const rocks = new Mesh("rockyBeachImpostorProceduralSource", scene);
  data.applyToMesh(rocks);
  rocks.isPickable = false;
  rocks.useVertexColors = true;
  const material = createVertexColorCaptureMaterial(
    scene,
    "rockyBeachImpostorSourceMaterial",
    liveLighting,
  );
  material.setFloat("rockTextureStrength", 1);
  rocks.material = material;
  return rocks;
}

/** Uses the captured patch geometry up close without introducing an external asset. */
export function createRockyBeachModel(scene: Scene, renderHeight: number, seed?: number): Mesh {
  const rocks = createRockyBeachSource(scene, true, seed);
  rocks.name = "rockyBeachModels";
  const positions = rocks.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) throw new Error("Rocky beach model has no position data.");
  const scale = renderHeight / SOURCE_HEIGHT;
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] *= scale;
    positions[index + 1] = positions[index + 1] * scale + renderHeight / 2;
    positions[index + 2] *= scale;
  }
  rocks.setVerticesData(VertexBuffer.PositionKind, positions);
  rocks.refreshBoundingInfo({ updatePositionsArray: false });
  if (rocks.material instanceof ShaderMaterial) {
    rocks.material.setFloat("modelHeight", renderHeight);
  }
  return rocks;
}
