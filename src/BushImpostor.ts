import { Color3, Mesh, Scene, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
import {
  createVertexColorCaptureMaterial,
  setVertexColorModelHeight,
} from "./ProceduralCaptureMaterial";
import {
  AXISYMMETRIC_IMPOSTOR_FACES,
  createImpostorAssetProvider,
  ImpostorAssets,
} from "./Impostor";
import { createSeededRandom } from "./Random";

export type BushImpostorAssets = ImpostorAssets;

const SOURCE_HEIGHT = 2.2;
const CAPTURE_DIAMETER = 4.5;
const FOLIAGE_PALETTES: ReadonlyArray<readonly [Color3, Color3]> = [
  [new Color3(0.075, 0.22, 0.065), new Color3(0.23, 0.5, 0.14)],
  [new Color3(0.1, 0.27, 0.07), new Color3(0.34, 0.59, 0.15)],
  [new Color3(0.13, 0.3, 0.08), new Color3(0.42, 0.65, 0.18)],
  [new Color3(0.15, 0.25, 0.065), new Color3(0.48, 0.55, 0.14)],
];

const bushImpostors = createImpostorAssetProvider({
  name: "bushImpostor",
  queryPrefix: "bush-impostor",
  createSource: (scene) => createBushSource(scene),
  sourceHeight: SOURCE_HEIGHT,
  captureDiameter: CAPTURE_DIAMETER,
  faces: AXISYMMETRIC_IMPOSTOR_FACES,
  rotationallySymmetric: true,
  upperHemisphereOnly: true,
  sampling: {
    horizontalSamples: { default: 1, minimum: 1, maximum: 16 },
    verticalSamples: { default: 5, minimum: 1, maximum: 10 },
    resolution: { default: 96, minimum: 48, maximum: 512 },
  },
});

/** Shares one shrub atlas capture per scene and capture-attribute combination. */
export function getBushImpostorAssets(
  scene: Scene,
  horizontalSamples = bushImpostors.getDefaultSampling().horizontalSamples,
  verticalSamples = bushImpostors.getDefaultSampling().verticalSamples,
  resolution = bushImpostors.getDefaultSampling().resolution,
): Promise<BushImpostorAssets> {
  return bushImpostors.getAssets(scene, {
    horizontalSamples,
    verticalSamples,
    resolution,
  });
}

function createBushSource(scene: Scene, liveLighting = false): Mesh {
  const random = createSeededRandom(0x42555348);
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const symmetryOrder = 12;
  const sectorAngle = Math.PI * 2 / symmetryOrder;

  const branchBase = new Vector3(0, -SOURCE_HEIGHT / 2, 0);
  for (let branch = 0; branch < 2; branch++) {
    const angle = random() * sectorAngle;
    const distance = 0.3 + random() * 0.72;
    const startRadius = random() * 0.08;
    const startAngle = random() * sectorAngle;
    const endY = -0.32 + random() * 1.18;
    const radius = 0.022 + random() * 0.028;
    for (let copy = 0; copy < symmetryOrder; copy++) {
      const rotation = copy * sectorAngle;
      const start = branch === 0
        ? branchBase
        : new Vector3(
          Math.cos(startAngle + rotation) * startRadius,
          -1.08,
          Math.sin(startAngle + rotation) * startRadius,
        );
      const end = new Vector3(
        Math.cos(angle + rotation) * distance,
        endY,
        Math.sin(angle + rotation) * distance,
      );
      addBranch(positions, indices, colors, start, end, radius, 5);
    }
  }

  const segments = 5;
  const shootCount = 900;
  for (let shoot = 0; shoot < shootCount / symmetryOrder; shoot++) {
    const baseAngle = random() * sectorAngle;
    const edgeRadius = 0.96
      + Math.sin(baseAngle * 3 + 0.4) * 0.12
      + Math.sin(baseAngle * 7 + 1.6) * 0.07;
    const radius = Math.sqrt(random()) * edgeRadius;
    const bladeAngle = random() * Math.PI * 2;
    const bendAngle = baseAngle + (random() - 0.5) * 1.7;
    const edgeScale = 1 - 0.34 * Math.pow(radius / edgeRadius, 2);
    const height = (0.65 + Math.pow(random(), 0.65) * 1.55) * edgeScale;
    const bend = (0.04 + random() * 0.22) * height;
    const width = 0.018 + Math.pow(random(), 1.45) * 0.072;
    const palette = FOLIAGE_PALETTES[Math.floor(random() * FOLIAGE_PALETTES.length)];
    const brightness = 0.84 + random() * 0.3;

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
        const taper = Math.max(0.035, 1 - t * t);
        const curve = bend * t * t;
        const centerX = baseX + Math.cos(rotatedBendAngle) * curve;
        const centerZ = baseZ + Math.sin(rotatedBendAngle) * curve;
        const centerY = -SOURCE_HEIGHT / 2 + height * t;
        const halfWidth = width * taper;
        const mix = 0.18 + t * 0.68;
        const light = brightness * (0.82 + t * 0.18);
        const red = (palette[0].r + (palette[1].r - palette[0].r) * mix) * light;
        const green = (palette[0].g + (palette[1].g - palette[0].g) * mix) * light;
        const blue = (palette[0].b + (palette[1].b - palette[0].b) * mix) * light;

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

  const data = new VertexData();
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.colors = colors;

  const bush = new Mesh("bushImpostorProceduralSource", scene);
  data.applyToMesh(bush);
  bush.isPickable = false;
  bush.useVertexColors = true;
  bush.material = createVertexColorCaptureMaterial(
    scene,
    "bushImpostorSourceMaterial",
    liveLighting,
  );
  return bush;
}

/** Builds the original procedural geometry at the requested rendered height. */
export function createBushModel(scene: Scene, renderHeight: number): Mesh {
  const bush = createBushSource(scene, true);
  bush.name = "bushModels";
  const positions = bush.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) throw new Error("Bush model has no position data.");

  const scale = renderHeight / SOURCE_HEIGHT;
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] *= scale;
    positions[index + 1] = positions[index + 1] * scale + renderHeight / 2;
    positions[index + 2] *= scale;
  }
  bush.setVerticesData(VertexBuffer.PositionKind, positions);
  bush.refreshBoundingInfo();
  setVertexColorModelHeight(bush, renderHeight);
  return bush;
}

function addBranch(
  positions: number[],
  indices: number[],
  colors: number[],
  start: Vector3,
  end: Vector3,
  radius: number,
  sides: number,
): void {
  const vertexStart = positions.length / 3;
  const direction = end.subtract(start).normalize();
  const reference = Math.abs(direction.y) < 0.9 ? Vector3.Up() : Vector3.Right();
  const axisX = Vector3.Cross(direction, reference).normalize();
  const axisZ = Vector3.Cross(direction, axisX).normalize();

  for (let ring = 0; ring < 2; ring++) {
    const center = ring === 0 ? start : end;
    const ringRadius = ring === 0 ? radius : radius * 0.35;
    for (let side = 0; side < sides; side++) {
      const angle = Math.PI * 2 * side / sides;
      const offset = axisX.scale(Math.cos(angle) * ringRadius)
        .add(axisZ.scale(Math.sin(angle) * ringRadius));
      const point = center.add(offset);
      positions.push(point.x, point.y, point.z);
      const shade = 0.8 + ring * 0.14;
      colors.push(0.2 * shade, 0.105 * shade, 0.045 * shade, 1);
    }
  }

  for (let side = 0; side < sides; side++) {
    const nextSide = (side + 1) % sides;
    const bottom = vertexStart + side;
    const top = vertexStart + sides + side;
    indices.push(bottom, top, vertexStart + nextSide, vertexStart + nextSide, top, vertexStart + sides + nextSide);
  }
}
