import { Color3, Mesh, Scene, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
import {
  createVertexColorCaptureMaterial,
  setVertexColorModelHeight,
} from "./ProceduralCaptureMaterial";
import {
  AXISYMMETRIC_IMPOSTOR_FACES,
  createImpostorAssetProvider,
  ImpostorAssetLease,
  ImpostorAssets,
  ImpostorVariant,
} from "./Impostor";
import { createSeededRandom } from "./Random";

export type FernImpostorAssets = ImpostorAssets;

const SOURCE_HEIGHT = 1.2;
const CAPTURE_DIAMETER = 2.7;

export function fernRenderedCaptureSize(renderHeight: number): number {
  return CAPTURE_DIAMETER * renderHeight / SOURCE_HEIGHT;
}
const ROTATIONAL_SYMMETRY_ORDER = 8;
const DARK_GREEN = new Color3(0.055, 0.18, 0.07);
const MID_GREEN = new Color3(0.12, 0.34, 0.1);
const TIP_GREEN = new Color3(0.26, 0.5, 0.15);

const fernImpostors = createImpostorAssetProvider({
  name: "fernImpostor",
  queryPrefix: "fern-impostor",
  createSource: (scene, variant) => createFernSource(scene, false, variant.seed),
  sourceHeight: SOURCE_HEIGHT,
  captureDiameter: CAPTURE_DIAMETER,
  faces: AXISYMMETRIC_IMPOSTOR_FACES,
  rotationallySymmetric: true,
  rotationalSymmetryOrder: ROTATIONAL_SYMMETRY_ORDER,
  upperHemisphereOnly: true,
  sampling: {
    horizontalSamples: { default: 5, minimum: 1, maximum: 16 },
    verticalSamples: { default: 6, minimum: 1, maximum: 12 },
    resolution: { default: 112, minimum: 48, maximum: 512 },
  },
});

/** Shares one procedural fern atlas per scene and capture configuration. */
export function getFernImpostorAssets(
  scene: Scene,
  horizontalSamples = fernImpostors.getDefaultSampling().horizontalSamples,
  verticalSamples = fernImpostors.getDefaultSampling().verticalSamples,
  resolution = fernImpostors.getDefaultSampling().resolution,
  variant?: ImpostorVariant,
): Promise<FernImpostorAssets> {
  return fernImpostors.getAssets(scene, {
    horizontalSamples,
    verticalSamples,
    resolution,
  }, variant);
}

export function acquireFernImpostorAssets(
  scene: Scene,
  variant: ImpostorVariant,
): Promise<ImpostorAssetLease> {
  return fernImpostors.acquireAssets(scene, undefined, variant);
}

/** Builds a radial clump of arched stems and paired, tapered fern leaflets. */
function createFernSource(scene: Scene, liveLighting = false, seed = 0x4645524e): Mesh {
  const random = createSeededRandom(seed);
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const baseY = -SOURCE_HEIGHT / 2;
  const sectorAngle = Math.PI * 2 / ROTATIONAL_SYMMETRY_ORDER;

  for (let variant = 0; variant < 4; variant++) {
    const lowLayer = variant < 2;
    const localAngle = random() * sectorAngle;
    const baseRadius = 0.12 + random() * 0.16;
    const reach = lowLayer
      ? 0.68 + random() * 0.2
      : 0.48 + random() * 0.18;
    const rise = lowLayer
      ? 0.5 + random() * 0.18
      : 0.82 + random() * 0.18;
    const rachisWidth = 0.017 + random() * 0.01;
    const brightness = 0.82 + random() * 0.24;

    for (let copy = 0; copy < ROTATIONAL_SYMMETRY_ORDER; copy++) {
      const angle = localAngle + copy * sectorAngle;
      const outward = new Vector3(Math.cos(angle), 0, Math.sin(angle));
      const sideways = new Vector3(-outward.z, 0, outward.x);
      const centers: Vector3[] = [];
      for (let segment = 0; segment <= 8; segment++) {
        const t = segment / 8;
        const radius = baseRadius + reach * (0.12 * t + 0.88 * Math.pow(t, 1.35));
        const height = rise * Math.sin(t * Math.PI * 0.78);
        centers.push(outward.scale(radius).add(new Vector3(0, baseY + height, 0)));
      }

      const rachisStart = positions.length / 3;
      for (let segment = 0; segment < centers.length; segment++) {
        const taper = 1 - segment / (centers.length - 1) * 0.72;
        const halfWidth = rachisWidth * taper;
        pushVertex(centers[segment].subtract(sideways.scale(halfWidth)), DARK_GREEN, brightness);
        pushVertex(centers[segment].add(sideways.scale(halfWidth)), DARK_GREEN, brightness);
      }
      for (let segment = 0; segment < centers.length - 1; segment++) {
        const left = rachisStart + segment * 2;
        indices.push(left, left + 2, left + 1, left + 1, left + 2, left + 3);
      }

      for (let segment = 1; segment <= 7; segment++) {
        const t = segment / 8;
        // Bias the broadest leaflets toward the lower half so the clump reads
        // as ground-covering foliage instead of a narrow stem with a top fan.
        const fullness = Math.pow(Math.sin(Math.PI * t), 0.5) * (1 - t * 0.28);
        const leafletLength = (0.1 + reach * 0.2) * fullness;
        const leafletWidth = (0.034 + leafletLength * 0.2) * fullness;
        const center = centers[segment];
        const color = Color3.Lerp(MID_GREEN, TIP_GREEN, t * 0.72);
        addLeaflet(center, sideways, outward, leafletLength, leafletWidth, color, brightness);
        addLeaflet(center, sideways.scale(-1), outward, leafletLength, leafletWidth, color, brightness);
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
  const fern = new Mesh("fernImpostorProceduralSource", scene);
  data.applyToMesh(fern);
  fern.isPickable = false;
  fern.useVertexColors = true;
  fern.material = createVertexColorCaptureMaterial(
    scene,
    "fernImpostorSourceMaterial",
    liveLighting,
  );
  return fern;

  function pushVertex(point: Vector3, color: Color3, brightness: number): number {
    positions.push(point.x, point.y, point.z);
    colors.push(
      Math.min(1, color.r * brightness),
      Math.min(1, color.g * brightness),
      Math.min(1, color.b * brightness),
      1,
    );
    return positions.length / 3 - 1;
  }

  function addLeaflet(
    root: Vector3,
    direction: Vector3,
    forward: Vector3,
    length: number,
    width: number,
    color: Color3,
    brightness: number,
  ): void {
    const start = positions.length / 3;
    const shoulder = root.add(direction.scale(length * 0.48));
    const tip = root.add(direction.scale(length)).add(forward.scale(length * 0.16));
    pushVertex(root, color.scale(0.72), brightness);
    pushVertex(shoulder.subtract(forward.scale(width)), color, brightness);
    pushVertex(tip, color.scale(1.08), brightness);
    pushVertex(shoulder.add(forward.scale(width)), color, brightness);
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
}

/** Builds the captured fern clump as live geometry for nearby instances. */
export function createFernModel(scene: Scene, renderHeight: number, seed?: number): Mesh {
  const fern = createFernSource(scene, true, seed);
  fern.name = "fernModels";
  const positions = fern.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) throw new Error("Fern model has no position data.");

  const scale = renderHeight / SOURCE_HEIGHT;
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] *= scale;
    positions[index + 1] = positions[index + 1] * scale + renderHeight / 2;
    positions[index + 2] *= scale;
  }
  fern.setVerticesData(VertexBuffer.PositionKind, positions);
  fern.refreshBoundingInfo();
  setVertexColorModelHeight(fern, renderHeight);
  return fern;
}
