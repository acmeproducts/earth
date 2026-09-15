import { Color3, Mesh, Scene, Vector3, VertexData } from "@babylonjs/core";
import {
  AXISYMMETRIC_IMPOSTOR_FACES,
  createImpostorAssetProvider,
} from "../rendering/Impostor";
import type { ImpostorAssetLease, ImpostorVariant } from "../rendering/Impostor";
import { createVertexColorCaptureMaterial, scaleVertexColorModel } from "../procedural/ProceduralCaptureMaterial";
import { createSeededRandom } from "../core/Random";

const SOURCE_HEIGHT = 1.42;
const CAPTURE_DIAMETER = 2.15;
const STEM = new Color3(0.34, 0.42, 0.075);
const LEAF = new Color3(0.5, 0.55, 0.09);
const GRAIN = new Color3(0.68, 0.53, 0.19);
const GRAIN_HIGHLIGHT = new Color3(0.8, 0.68, 0.3);

export function wheatRenderedCaptureSize(renderHeight: number): number {
  return CAPTURE_DIAMETER * renderHeight / SOURCE_HEIGHT;
}

const wheatImpostors = createImpostorAssetProvider({
  name: "wheatImpostor",
  queryPrefix: "wheat-impostor",
  createSource: (scene, variant) => createWheatSource(scene, false, variant.seed),
  sourceHeight: SOURCE_HEIGHT,
  captureDiameter: CAPTURE_DIAMETER,
  faces: AXISYMMETRIC_IMPOSTOR_FACES,
  rotationallySymmetric: true,
  rotationalSymmetryOrder: 4,
  upperHemisphereOnly: true,
  sampling: {
    horizontalSamples: { default: 5, minimum: 1, maximum: 16 },
    verticalSamples: { default: 5, minimum: 1, maximum: 12 },
    resolution: { default: 112, minimum: 48, maximum: 512 },
  },
});

export function acquireWheatImpostorAssets(
  scene: Scene,
  variant: ImpostorVariant,
): Promise<ImpostorAssetLease> {
  return wheatImpostors.acquireAssets(scene, undefined, variant);
}

function createWheatSource(scene: Scene, liveLighting = false, seed = 0x57484541): Mesh {
  const random = createSeededRandom(seed);
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const baseY = -SOURCE_HEIGHT / 2;

  for (let stalk = 0; stalk < 28; stalk++) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * 0.72;
    const base = new Vector3(Math.cos(angle) * radius, baseY, Math.sin(angle) * radius);
    const height = 0.78 + random() * 0.32;
    const leanAngle = random() * Math.PI * 2;
    const lean = 0.025 + random() * 0.1;
    const top = base.add(new Vector3(Math.cos(leanAngle) * lean, height, Math.sin(leanAngle) * lean));
    addTube(base, top, 0.009, STEM, 5);
    const leafPhase = random() * Math.PI * 2;
    for (let leaf = 0; leaf < 3; leaf++) {
      const t = 0.22 + leaf * 0.18 + random() * 0.05;
      const center = Vector3.Lerp(base, top, t);
      const direction = new Vector3(Math.cos(leafPhase + leaf * 2.7), 0.12, Math.sin(leafPhase + leaf * 2.7));
      addBlade(center, direction, 0.15, 0.075, LEAF);
    }
    const head = Vector3.Lerp(base, top, 0.89);
    const headTop = head.add(new Vector3(0, 0.25, 0));
    addTube(head, headTop, 0.012, GRAIN, 5);
    // Wheat ears are made from alternating, plump spikelets rather than a
    // single flat spike. This keeps the characteristic layered silhouette at
    // close range and also produces much more natural atlas captures.
    for (let grain = 0; grain < 8; grain++) {
      const t = grain / 7;
      const sideSign = grain % 2 === 0 ? 1 : -1;
      const side = new Vector3(
        Math.cos(leafPhase + 0.45) * sideSign,
        0.08,
        Math.sin(leafPhase + 0.45) * sideSign,
      ).normalize();
      const center = Vector3.Lerp(head, headTop, 0.08 + t * 0.84)
        .add(side.scale(0.028 + (grain % 3) * 0.004));
      addKernel(center, side, grain % 3 === 0 ? GRAIN_HIGHLIGHT : GRAIN);
      const awnStart = center.add(new Vector3(0, 0.025, 0));
      addTube(awnStart, awnStart.add(side.scale(0.075)).add(new Vector3(0, 0.08, 0)), 0.0025, GRAIN_HIGHLIGHT, 4);
    }
  }

  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions; data.indices = indices; data.normals = normals; data.colors = colors;
  const wheat = new Mesh("wheatImpostorProceduralSource", scene);
  data.applyToMesh(wheat); wheat.isPickable = false; wheat.useVertexColors = true;
  wheat.material = createVertexColorCaptureMaterial(scene, "wheatImpostorSourceMaterial", liveLighting);
  return wheat;

  function push(point: Vector3, color: Color3): number {
    positions.push(point.x, point.y, point.z); colors.push(color.r, color.g, color.b, 1);
    return positions.length / 3 - 1;
  }
  function addTube(start: Vector3, end: Vector3, radius: number, color: Color3, sides: number): void {
    const axis = end.subtract(start).normalize();
    const helper = Math.abs(axis.y) < 0.9 ? Vector3.Up() : Vector3.Right();
    const tangent = Vector3.Cross(axis, helper).normalize();
    const bitangent = Vector3.Cross(axis, tangent).normalize();
    const ringStart = positions.length / 3;
    for (const point of [start, end]) {
      for (let side = 0; side < sides; side++) {
        const angle = side / sides * Math.PI * 2;
        push(point.add(tangent.scale(Math.cos(angle) * radius)).add(bitangent.scale(Math.sin(angle) * radius)), color);
      }
    }
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      indices.push(ringStart + side, ringStart + next, ringStart + sides + next, ringStart + side, ringStart + sides + next, ringStart + sides + side);
    }
  }
  function addBlade(base: Vector3, direction: Vector3, height: number, width: number, color: Color3): void {
    const facing = Vector3.Cross(direction, Vector3.Up()).normalize();
    const segments = 3;
    const start = positions.length / 3;
    for (let segment = 0; segment <= segments; segment++) {
      const t = segment / segments;
      const center = base.add(direction.scale(height * (0.14 * t + 0.12 * t * t))).add(Vector3.Up().scale(height * t));
      const halfWidth = width * (1 - t) * 0.5;
      push(center.subtract(facing.scale(halfWidth)), color);
      push(center.add(facing.scale(halfWidth)), color);
    }
    for (let segment = 0; segment < segments; segment++) {
      const left = start + segment * 2;
      indices.push(left, left + 2, left + 1, left + 1, left + 2, left + 3);
    }
  }
  function addKernel(center: Vector3, side: Vector3, color: Color3): void {
    const axis = Vector3.Up();
    const facing = Vector3.Cross(axis, side).normalize();
    const start = positions.length / 3;
    const tipTop = center.add(axis.scale(0.035));
    const tipBottom = center.subtract(axis.scale(0.035));
    push(tipTop, color); push(tipBottom, color);
    for (const point of [center.add(side.scale(0.035)), center.subtract(side.scale(0.035)), center.add(facing.scale(0.024)), center.subtract(facing.scale(0.024))]) push(point, color);
    for (let ring = 0; ring < 4; ring++) {
      const next = (ring + 1) % 4;
      indices.push(start, start + 2 + ring, start + 2 + next, start + 1, start + 2 + next, start + 2 + ring);
    }
  }
}

export function createWheatModel(scene: Scene, renderHeight: number, seed?: number): Mesh {
  const wheat = createWheatSource(scene, true, seed);
  wheat.name = "wheatModels";
  scaleVertexColorModel(wheat, renderHeight, SOURCE_HEIGHT);
  return wheat;
}
