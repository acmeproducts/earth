import { Color3, Mesh, Scene, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
import {
  AXISYMMETRIC_IMPOSTOR_FACES,
  createImpostorAssetProvider,
  ImpostorAssets,
} from "./Impostor";
import {
  createVertexColorCaptureMaterial,
  setVertexColorModelHeight,
} from "./ProceduralCaptureMaterial";

export type FlowerImpostorAssets = ImpostorAssets;

const SOURCE_HEIGHT = 0.68;
const CAPTURE_DIAMETER = 2.4;
const STEM = new Color3(0.12, 0.36, 0.08);
const LEAF = new Color3(0.18, 0.47, 0.1);
const CENTER = new Color3(1, 0.67, 0.035);
const PETAL = new Color3(0.98, 0.96, 0.9);
const PETAL_SHADOW = new Color3(0.78, 0.8, 0.7);

const flowerImpostors = createImpostorAssetProvider({
  name: "flowerImpostor",
  queryPrefix: "flower-impostor",
  createSource: createFlowerSource,
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

export function getFlowerImpostorAssets(scene: Scene): Promise<FlowerImpostorAssets> {
  return flowerImpostors.getAssets(scene);
}

/** Builds a neutral daisy patch tinted per instance by the render shader. */
function createFlowerSource(scene: Scene, liveLighting = false): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const random = mulberry32(0x464c4f57);

  const addVertex = (position: Vector3, color: Color3): number => {
    positions.push(position.x, position.y, position.z);
    colors.push(color.r, color.g, color.b, 1);
    return positions.length / 3 - 1;
  };
  const addQuad = (center: Vector3, across: Vector3, up: Vector3, color: Color3): void => {
    const start = positions.length / 3;
    addVertex(center.subtract(across).subtract(up), color);
    addVertex(center.add(across).subtract(up), color);
    addVertex(center.add(across).add(up), color);
    addVertex(center.subtract(across).add(up), color);
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  };

  for (let flower = 0; flower < 26; flower++) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * 0.88;
    const base = new Vector3(Math.cos(angle) * radius, -SOURCE_HEIGHT / 2, Math.sin(angle) * radius);
    const height = 0.38 + random() * 0.28;
    const lean = new Vector3((random() - 0.5) * 0.11, height, (random() - 0.5) * 0.11);
    const head = base.add(lean);
    const stemCenter = Vector3.Center(base, head);
    const stemHalf = head.subtract(base).scale(0.5);
    const stemWidth = 0.012 + random() * 0.007;
    addQuad(stemCenter, new Vector3(stemWidth, 0, 0), stemHalf, STEM);
    addQuad(stemCenter, new Vector3(0, 0, stemWidth), stemHalf, STEM);

    if (random() < 0.75) {
      const leafCenter = Vector3.Lerp(base, head, 0.42 + random() * 0.2);
      const leafAngle = random() * Math.PI * 2;
      const leafDirection = new Vector3(Math.cos(leafAngle), 0.22, Math.sin(leafAngle));
      addQuad(
        leafCenter.add(leafDirection.scale(0.055)),
        new Vector3(-leafDirection.z, 0, leafDirection.x).scale(0.024),
        leafDirection.scale(0.075),
        LEAF,
      );
    }

    const normal = new Vector3((random() - 0.5) * 0.75, 1, (random() - 0.5) * 0.75).normalize();
    const tangent = Vector3.Cross(Math.abs(normal.y) > 0.9 ? Vector3.Right() : Vector3.Up(), normal).normalize();
    const bitangent = Vector3.Cross(normal, tangent).normalize();
    const petalLength = 0.075 + random() * 0.025;
    const petalWidth = petalLength * 0.42;
    const petalCount = 9;
    for (let petal = 0; petal < petalCount; petal++) {
      const petalAngle = petal / petalCount * Math.PI * 2 + random() * 0.08;
      const direction = tangent.scale(Math.cos(petalAngle)).add(bitangent.scale(Math.sin(petalAngle)));
      const side = Vector3.Cross(normal, direction).normalize();
      const root = head.add(direction.scale(0.018));
      const tip = head.add(direction.scale(petalLength));
      const start = positions.length / 3;
      addVertex(root.subtract(side.scale(petalWidth * 0.28)), PETAL_SHADOW);
      addVertex(root.add(side.scale(petalWidth * 0.28)), PETAL_SHADOW);
      addVertex(Vector3.Lerp(root, tip, 0.62).add(side.scale(petalWidth)), PETAL);
      addVertex(tip, PETAL);
      addVertex(Vector3.Lerp(root, tip, 0.62).subtract(side.scale(petalWidth)), PETAL);
      indices.push(start, start + 1, start + 2, start, start + 2, start + 3, start, start + 3, start + 4);
    }

    const centerRadius = petalLength * 0.3;
    const centerPoint = head.add(normal.scale(0.008));
    const centerVertex = addVertex(centerPoint, CENTER);
    for (let segment = 0; segment < 10; segment++) {
      const a = segment / 10 * Math.PI * 2;
      const b = (segment + 1) / 10 * Math.PI * 2;
      const first = addVertex(centerPoint.add(tangent.scale(Math.cos(a) * centerRadius)).add(bitangent.scale(Math.sin(a) * centerRadius)), CENTER);
      const second = addVertex(centerPoint.add(tangent.scale(Math.cos(b) * centerRadius)).add(bitangent.scale(Math.sin(b) * centerRadius)), CENTER);
      indices.push(centerVertex, first, second);
    }
  }

  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.colors = colors;
  const flowers = new Mesh("flowerImpostorProceduralSource", scene);
  data.applyToMesh(flowers);
  flowers.isPickable = false;
  flowers.useVertexColors = true;
  flowers.material = createVertexColorCaptureMaterial(
    scene,
    "flowerImpostorSourceMaterial",
    liveLighting,
  );
  return flowers;
}

/** Builds the flower patch as live geometry for nearby instances. */
export function createFlowerModel(scene: Scene, renderHeight: number): Mesh {
  const flowers = createFlowerSource(scene, true);
  flowers.name = "flowerModels";
  const positions = flowers.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) throw new Error("Flower model has no position data.");

  const scale = renderHeight / SOURCE_HEIGHT;
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] *= scale;
    positions[index + 1] = positions[index + 1] * scale + renderHeight / 2;
    positions[index + 2] *= scale;
  }
  flowers.setVerticesData(VertexBuffer.PositionKind, positions);
  flowers.refreshBoundingInfo();
  setVertexColorModelHeight(flowers, renderHeight);
  return flowers;
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
