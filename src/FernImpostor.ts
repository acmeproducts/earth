import { Mesh, Scene, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
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
const FROND_SEGMENTS = 8;
const FERN_FOLIAGE_TEXTURE_URL = require(
  "../assets/vegetation/fern/foliage.png",
) as string;

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

/** Builds a radial clump of textured fronds on arched ribbon cards. */
function createFernSource(scene: Scene, liveLighting = false, seed = 0x4645524e): Mesh {
  const random = createSeededRandom(seed);
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
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
    const frondHalfWidth = (0.21 + reach * 0.15) * (0.9 + random() * 0.2);
    const brightness = 0.82 + random() * 0.24;

    for (let copy = 0; copy < ROTATIONAL_SYMMETRY_ORDER; copy++) {
      const angle = localAngle + copy * sectorAngle;
      const outward = new Vector3(Math.cos(angle), 0, Math.sin(angle));
      const sideways = new Vector3(-outward.z, 0, outward.x);
      const centers: Vector3[] = [];
      for (let segment = 0; segment <= FROND_SEGMENTS; segment++) {
        const t = segment / FROND_SEGMENTS;
        const radius = baseRadius + reach * (0.12 * t + 0.88 * Math.pow(t, 1.35));
        const height = rise * Math.sin(t * Math.PI * 0.78);
        centers.push(outward.scale(radius).add(new Vector3(0, baseY + height, 0)));
      }

      const ribbonStart = positions.length / 3;
      for (let segment = 0; segment < centers.length; segment++) {
        const t = segment / FROND_SEGMENTS;
        pushVertex(centers[segment].subtract(sideways.scale(frondHalfWidth)), brightness);
        pushVertex(centers[segment].add(sideways.scale(frondHalfWidth)), brightness);
        // The supplied image is upright: stem at the bottom, tip at the top.
        uvs.push(0, 1 - t, 1, 1 - t);
      }
      for (let segment = 0; segment < centers.length - 1; segment++) {
        const left = ribbonStart + segment * 2;
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
  data.uvs = uvs;
  const fern = new Mesh("fernImpostorProceduralSource", scene);
  data.applyToMesh(fern);
  fern.isPickable = false;
  fern.useVertexColors = true;
  fern.material = createVertexColorCaptureMaterial(
    scene,
    "fernImpostorSourceMaterial",
    liveLighting,
    FERN_FOLIAGE_TEXTURE_URL,
  );
  return fern;

  function pushVertex(point: Vector3, brightness: number): number {
    positions.push(point.x, point.y, point.z);
    // Keep seed-to-seed variation without repainting the supplied foliage.
    colors.push(
      Math.min(1, brightness * 0.94),
      Math.min(1, brightness),
      Math.min(1, brightness * 0.9),
      1,
    );
    return positions.length / 3 - 1;
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
