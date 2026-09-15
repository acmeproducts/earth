import { Mesh, Scene, Vector3, VertexData } from "@babylonjs/core";
import {
  createVertexColorCaptureMaterial,
  scaleVertexColorModel,
} from "../procedural/ProceduralCaptureMaterial";
import {
  createImpostorAssetProvider,
  IMPOSTOR_CUBE_FACES,
  ImpostorAssetLease,
  ImpostorVariant,
} from "../rendering/Impostor";
import { createSeededRandom } from "../core/Random";

const SOURCE_HEIGHT = 1.2;
const CAPTURE_DIAMETER = 2.7;

export function fernRenderedCaptureSize(renderHeight: number): number {
  return CAPTURE_DIAMETER * renderHeight / SOURCE_HEIGHT;
}
const FROND_COUNT = 18;
const FROND_SEGMENTS = 8;
const FERN_FOLIAGE_TEXTURE_URL = require(
  "../../assets/vegetation/fern/foliage.png",
) as string;

const fernImpostors = createImpostorAssetProvider({
  name: "fernImpostor",
  queryPrefix: "fern-impostor",
  createSource: (scene, variant) => createFernSource(scene, false, variant.seed),
  sourceHeight: SOURCE_HEIGHT,
  captureDiameter: CAPTURE_DIAMETER,
  faces: IMPOSTOR_CUBE_FACES,
  rotationallySymmetric: false,
  upperHemisphereOnly: true,
  sampling: {
    horizontalSamples: { default: 5, minimum: 1, maximum: 16 },
    verticalSamples: { default: 5, minimum: 1, maximum: 12 },
    resolution: { default: 112, minimum: 48, maximum: 512 },
  },
});

export function acquireFernImpostorAssets(
  scene: Scene,
  variant: ImpostorVariant,
): Promise<ImpostorAssetLease> {
  return fernImpostors.acquireAssets(scene, undefined, variant);
}

/** Builds upright fronds staggered along a short, irregular rhizome. */
function createFernSource(scene: Scene, liveLighting = false, seed = 0x4645524e): Mesh {
  const random = createSeededRandom(seed);
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const baseY = -SOURCE_HEIGHT / 2;
  const rhizomeAngle = random() * Math.PI * 2;
  const rhizome = new Vector3(Math.cos(rhizomeAngle), 0, Math.sin(rhizomeAngle));
  const rhizomeSide = new Vector3(-rhizome.z, 0, rhizome.x);

  for (let frond = 0; frond < FROND_COUNT; frond++) {
    const positionAlongRhizome = (frond / (FROND_COUNT - 1) - 0.5) * 0.48
      + (random() - 0.5) * 0.06;
    const base = rhizome.scale(positionAlongRhizome)
      .add(rhizomeSide.scale((random() - 0.5) * 0.12));
    const sideOfRhizome = frond % 2 === 0 ? 1 : -1;
    const heading = rhizomeAngle
      + sideOfRhizome * (Math.PI * (0.34 + random() * 0.22))
      + (random() - 0.5) * 0.45;
    const outward = new Vector3(Math.cos(heading), 0, Math.sin(heading));
    const sideways = new Vector3(-outward.z, 0, outward.x);
    const mature = random() > 0.22;
    const reach = mature ? 0.2 + random() * 0.32 : 0.08 + random() * 0.18;
    const rise = mature ? 0.88 + random() * 0.26 : 0.56 + random() * 0.25;
    const frondHalfWidth = (mature ? 0.2 : 0.14) * (0.88 + random() * 0.24);
    const brightness = 0.82 + random() * 0.24;
    const lateralBow = (random() - 0.5) * 0.07;

    const centers: Vector3[] = [];
    for (let segment = 0; segment <= FROND_SEGMENTS; segment++) {
      const t = segment / FROND_SEGMENTS;
      const horizontal = reach * Math.pow(t, 1.8);
      const height = rise * (1.22 * t - 0.22 * t * t);
      centers.push(base
        .add(outward.scale(horizontal))
        .add(sideways.scale(Math.sin(t * Math.PI) * lateralBow))
        .add(new Vector3(0, baseY + height, 0)));
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
  scaleVertexColorModel(fern, renderHeight, SOURCE_HEIGHT);
  return fern;
}
