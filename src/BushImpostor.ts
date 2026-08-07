import { Color3, Mesh, Scene, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
import { createVertexColorCaptureMaterial } from "./ProceduralCaptureMaterial";
import {
  captureImpostorAtlases,
  ImpostorAssets,
  queryNumber,
} from "./TreeImpostor";

export type BushImpostorAssets = ImpostorAssets;

const SOURCE_HEIGHT = 2.2;
const CAPTURE_DIAMETER = 4.5;
const sceneAssets = new WeakMap<Scene, Promise<BushImpostorAssets>>();
const FOLIAGE_PALETTES: ReadonlyArray<readonly [Color3, Color3]> = [
  [new Color3(0.075, 0.22, 0.065), new Color3(0.23, 0.5, 0.14)],
  [new Color3(0.1, 0.27, 0.07), new Color3(0.34, 0.59, 0.15)],
  [new Color3(0.13, 0.3, 0.08), new Color3(0.42, 0.65, 0.18)],
  [new Color3(0.15, 0.25, 0.065), new Color3(0.48, 0.55, 0.14)],
];

/** Generates and captures a shrub once for every scene. */
export function getBushImpostorAssets(
  scene: Scene,
  horizontalSamples = queryNumber("bush-impostor-x-samples", 10, 1, 16),
  verticalSamples = queryNumber("bush-impostor-y-samples", 5, 1, 10),
  resolution = queryNumber("bush-impostor-resolution", 96, 48, 512),
): Promise<BushImpostorAssets> {
  const existing = sceneAssets.get(scene);
  if (existing) return existing;

  const capture = captureBush(scene, horizontalSamples, verticalSamples, resolution);
  sceneAssets.set(scene, capture);
  return capture;
}

async function captureBush(
  scene: Scene,
  horizontalSamples: number,
  verticalSamples: number,
  resolution: number,
): Promise<BushImpostorAssets> {
  const source = createBushSource(scene);
  await scene.whenReadyAsync();

  try {
    const assets = await captureImpostorAtlases(scene, {
      name: "bushImpostor",
      meshes: [source],
      gridWidth: horizontalSamples,
      gridHeight: verticalSamples,
      resolution,
      sourceHeight: SOURCE_HEIGHT,
      captureDiameter: CAPTURE_DIAMETER,
    });
    console.log("Bush impostor: capture complete; procedural source disposed");
    return assets;
  } finally {
    source.dispose(false, true);
  }
}

function createBushSource(scene: Scene, liveLighting = false): Mesh {
  const random = mulberry32(0x42555348);
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];

  const branchBase = new Vector3(0, -SOURCE_HEIGHT / 2, 0);
  for (let branch = 0; branch < 26; branch++) {
    const angle = random() * Math.PI * 2;
    const distance = 0.3 + random() * 0.72;
    const start = branch === 0
      ? branchBase
      : new Vector3((random() - 0.5) * 0.16, -1.08, (random() - 0.5) * 0.16);
    const end = new Vector3(
      Math.cos(angle) * distance,
      -0.32 + random() * 1.18,
      Math.sin(angle) * distance,
    );
    addBranch(positions, indices, colors, start, end, 0.022 + random() * 0.028, 5);
  }

  const segments = 5;
  const shootCount = 900;
  for (let shoot = 0; shoot < shootCount; shoot++) {
    const vertexStart = positions.length / 3;
    const baseAngle = random() * Math.PI * 2;
    const edgeRadius = 0.96
      + Math.sin(baseAngle * 3 + 0.4) * 0.12
      + Math.sin(baseAngle * 7 + 1.6) * 0.07;
    const radius = Math.sqrt(random()) * edgeRadius;
    const baseX = Math.cos(baseAngle) * radius;
    const baseZ = Math.sin(baseAngle) * radius;
    const bladeAngle = random() * Math.PI * 2;
    const sideX = Math.cos(bladeAngle);
    const sideZ = Math.sin(bladeAngle);
    const bendAngle = baseAngle + (random() - 0.5) * 1.7;
    const edgeScale = 1 - 0.34 * Math.pow(radius / edgeRadius, 2);
    const height = (0.65 + Math.pow(random(), 0.65) * 1.55) * edgeScale;
    const bend = (0.04 + random() * 0.22) * height;
    const width = 0.018 + Math.pow(random(), 1.45) * 0.072;
    const palette = FOLIAGE_PALETTES[Math.floor(random() * FOLIAGE_PALETTES.length)];
    const brightness = 0.84 + random() * 0.3;

    for (let segment = 0; segment <= segments; segment++) {
      const t = segment / segments;
      const taper = Math.max(0.035, 1 - t * t);
      const curve = bend * t * t;
      const centerX = baseX + Math.cos(bendAngle) * curve;
      const centerZ = baseZ + Math.sin(bendAngle) * curve;
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

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
