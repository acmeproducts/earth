import { Color3, Mesh, Scene, Vector3, VertexData } from "@babylonjs/core";
import { createVertexColorCaptureMaterial } from "./ProceduralCaptureMaterial";

export const PROCEDURAL_TREE_SOURCE_HEIGHT = 3;
export const PROCEDURAL_TREE_CAPTURE_DIAMETER = 4.25;

export interface ProceduralTreeOptions {
  seed?: number;
  name?: string;
  liveLighting?: boolean;
}

interface GeometryBuffers {
  positions: number[];
  indices: number[];
  colors: number[];
}

const BARK_BASE = new Color3(0.17, 0.085, 0.035);
const BARK_TIP = new Color3(0.34, 0.19, 0.075);
const BARK_GROOVE = new Color3(0.105, 0.048, 0.021);
const BARK_RIDGE = new Color3(0.42, 0.245, 0.105);
const LEAF_PALETTES: ReadonlyArray<readonly [Color3, Color3]> = [
  [new Color3(0.045, 0.18, 0.055), new Color3(0.18, 0.44, 0.095)],
  [new Color3(0.065, 0.23, 0.05), new Color3(0.27, 0.53, 0.105)],
  [new Color3(0.09, 0.26, 0.055), new Color3(0.35, 0.59, 0.12)],
  [new Color3(0.12, 0.25, 0.045), new Color3(0.43, 0.56, 0.105)],
];

/** Builds one deterministic broadleaf tree centered for directional impostor capture. */
export function createProceduralTree(
  scene: Scene,
  options: ProceduralTreeOptions = {},
): Mesh {
  const {
    seed = 0x54524545,
    name = "treeImpostorProceduralSource",
    liveLighting = false,
  } = options;
  const random = mulberry32(seed);
  const buffers: GeometryBuffers = { positions: [], indices: [], colors: [] };
  const foliageAnchors: Vector3[] = [];
  const trunkPoints: Vector3[] = [];
  const baseY = -PROCEDURAL_TREE_SOURCE_HEIGHT / 2;
  const trunkSegments = 9;

  for (let segment = 0; segment <= trunkSegments; segment++) {
    const t = segment / trunkSegments;
    trunkPoints.push(new Vector3(
      Math.sin(t * 4.7 + 0.4) * 0.035 * t,
      baseY + t * 2.55,
      Math.sin(t * 3.8 + 1.7) * 0.03 * t,
    ));
  }

  for (let segment = 0; segment < trunkSegments; segment++) {
    const t = segment / trunkSegments;
    addBranchSegment(
      buffers,
      trunkPoints[segment],
      trunkPoints[segment + 1],
      lerp(0.16, 0.045, Math.pow(t, 0.72)),
      lerp(0.145, 0.033, Math.pow((segment + 1) / trunkSegments, 0.72)),
      8,
      t,
    );
  }

  for (let root = 0; root < 5; root++) {
    const angle = root * Math.PI * 2 / 5 + 0.32;
    const direction = new Vector3(Math.cos(angle), 0, Math.sin(angle));
    const rootStart = trunkPoints[0].add(new Vector3(0, 0.12, 0));
    const rootMiddle = rootStart.add(direction.scale(0.15)).add(new Vector3(0, -0.045, 0));
    const rootEnd = rootStart.add(direction.scale(0.31 + Math.sin(root * 2.1) * 0.035))
      .add(new Vector3(0, -0.085, 0));
    addBranchSegment(buffers, rootStart, rootMiddle, 0.105, 0.07, 7, 0.02);
    addBranchSegment(buffers, rootMiddle, rootEnd, 0.07, 0.018, 6, 0.04, true);
  }

  for (const knot of [
    { level: 2, angle: 0.72, length: 0.055 },
    { level: 4, angle: 3.85, length: 0.042 },
  ]) {
    const heightT = knot.level / trunkSegments;
    const trunkRadius = lerp(0.16, 0.045, Math.pow(heightT, 0.72));
    const direction = new Vector3(Math.cos(knot.angle), 0.12, Math.sin(knot.angle)).normalize();
    const knotStart = trunkPoints[knot.level].add(direction.scale(trunkRadius * 0.78));
    const knotEnd = trunkPoints[knot.level].add(direction.scale(trunkRadius + knot.length));
    addBranchSegment(
      buffers,
      knotStart,
      knotEnd,
      trunkRadius * 0.38,
      trunkRadius * 0.24,
      7,
      heightT,
      true,
    );
  }

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let level = 2; level < trunkSegments; level++) {
    const branchesAtLevel = level < 5 ? 3 : 4;
    const start = trunkPoints[level];
    const crownT = (level - 2) / (trunkSegments - 3);
    const branchLength = lerp(0.82, 0.48, crownT) * (0.88 + random() * 0.22);

    for (let branch = 0; branch < branchesAtLevel; branch++) {
      const angle = level * goldenAngle + branch * Math.PI * 2 / branchesAtLevel + (random() - 0.5) * 0.3;
      const horizontal = new Vector3(Math.cos(angle), 0, Math.sin(angle));
      const middle = start.add(horizontal.scale(branchLength * 0.56))
        .add(new Vector3(0, branchLength * (0.12 + random() * 0.08), 0));
      const end = start.add(horizontal.scale(branchLength))
        .add(new Vector3(0, branchLength * (0.28 + random() * 0.16), 0));
      const branchRadius = lerp(0.06, 0.035, crownT) * (0.88 + random() * 0.2);
      const collarEnd = Vector3.Lerp(start, middle, 0.14);

      addBranchSegment(buffers, start, collarEnd, branchRadius * 1.28, branchRadius * 0.94, 7, crownT);
      addBranchSegment(buffers, collarEnd, middle, branchRadius * 0.92, branchRadius * 0.62, 6, crownT + 0.04);
      addBranchSegment(buffers, middle, end, branchRadius * 0.63, branchRadius * 0.27, 6, crownT + 0.12);
      foliageAnchors.push(end);

      for (const split of [-1, 1]) {
        const twigAngle = angle + split * (0.38 + random() * 0.3);
        const twigDirection = new Vector3(Math.cos(twigAngle), 0, Math.sin(twigAngle));
        const twigLength = branchLength * (0.27 + random() * 0.12);
        const twigEnd = middle.add(twigDirection.scale(twigLength))
          .add(new Vector3(0, twigLength * (0.42 + random() * 0.3), 0));
        addBranchSegment(buffers, middle, twigEnd, branchRadius * 0.4, branchRadius * 0.14, 5, crownT + 0.18);
        foliageAnchors.push(twigEnd);
      }
    }

    if (level >= 4) {
      foliageAnchors.push(start.add(new Vector3(
        (random() - 0.5) * 0.22,
        0.08 + random() * 0.12,
        (random() - 0.5) * 0.22,
      )));
    }
  }

  foliageAnchors.push(trunkPoints[trunkSegments].add(new Vector3(0, 0.2, 0)));
  for (const anchor of foliageAnchors) {
    const clusterScale = 0.82 + random() * 0.3;
    const clusterPaletteIndex = Math.floor(random() * LEAF_PALETTES.length);
    for (let leaf = 0; leaf < 36; leaf++) {
      const offset = randomInUnitSphere(random);
      const center = anchor.add(new Vector3(
        offset.x * 0.3 * clusterScale,
        offset.y * 0.34 * clusterScale,
        offset.z * 0.3 * clusterScale,
      ));
      const halfWidth = 0.055 + random() * 0.05;
      const halfLength = 0.105 + random() * 0.095;
      center.y = Math.min(PROCEDURAL_TREE_SOURCE_HEIGHT / 2 - halfLength, center.y);
      const paletteShift = random() < 0.18 ? (random() < 0.5 ? -1 : 1) : 0;
      const palette = LEAF_PALETTES[
        Math.max(0, Math.min(LEAF_PALETTES.length - 1, clusterPaletteIndex + paletteShift))
      ];
      const brightness = 0.78 + random() * 0.34 + Math.max(0, center.y) * 0.035;
      addLeaf(
        buffers,
        center,
        offset,
        halfWidth,
        halfLength,
        random,
        palette,
        brightness,
      );
    }
  }

  const data = new VertexData();
  const normals = new Float32Array(buffers.positions.length);
  VertexData.ComputeNormals(buffers.positions, buffers.indices, normals);
  data.positions = buffers.positions;
  data.indices = buffers.indices;
  data.normals = normals;
  data.colors = buffers.colors;

  const tree = new Mesh(name, scene);
  data.applyToMesh(tree);
  tree.isPickable = false;
  tree.useVertexColors = true;
  tree.material = createVertexColorCaptureMaterial(scene, `${name}Material`, liveLighting);
  return tree;
}

function addBranchSegment(
  buffers: GeometryBuffers,
  start: Vector3,
  end: Vector3,
  startRadius: number,
  endRadius: number,
  sides: number,
  heightT: number,
  endCap = false,
): void {
  const vertexStart = buffers.positions.length / 3;
  const direction = end.subtract(start).normalize();
  const reference = Math.abs(direction.y) < 0.92 ? Vector3.Up() : Vector3.Right();
  const axisX = Vector3.Cross(direction, reference).normalize();
  const axisZ = Vector3.Cross(direction, axisX).normalize();
  const ringCount = 3;

  for (let ring = 0; ring < ringCount; ring++) {
    const ringT = ring / (ringCount - 1);
    const center = Vector3.Lerp(start, end, ringT);
    const radius = lerp(startRadius, endRadius, ringT) * (ring === 1 ? 1.035 : 1);
    for (let side = 0; side < sides; side++) {
      const angle = Math.PI * 2 * side / sides + ringT * 0.09;
      const ridgeWave = Math.sin(angle * 3 + heightT * 10.5);
      const fineWave = Math.cos(angle * 5 - heightT * 7.2);
      const profileRadius = radius * (1 + ridgeWave * 0.055 + fineWave * 0.022);
      const point = center.add(axisX.scale(Math.cos(angle) * profileRadius))
        .add(axisZ.scale(Math.sin(angle) * profileRadius));
      buffers.positions.push(point.x, point.y, point.z);
      const barkT = Math.min(1, heightT * 0.62 + ringT * 0.1);
      const baseColor = mixColor(BARK_BASE, BARK_TIP, barkT);
      const detailColor = ridgeWave < -0.28
        ? mixColor(baseColor, BARK_GROOVE, Math.min(0.65, -ridgeWave * 0.52))
        : mixColor(baseColor, BARK_RIDGE, Math.max(0, ridgeWave) * 0.28);
      pushColor(buffers.colors, detailColor, 1);
    }
  }

  for (let ring = 0; ring < ringCount - 1; ring++) {
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      const bottom = vertexStart + ring * sides + side;
      const top = vertexStart + (ring + 1) * sides + side;
      buffers.indices.push(bottom, top, bottom - side + next, bottom - side + next, top, top - side + next);
    }
  }

  if (endCap) {
    const capCenter = buffers.positions.length / 3;
    buffers.positions.push(end.x, end.y, end.z);
    pushColor(buffers.colors, mixColor(BARK_GROOVE, BARK_BASE, 0.32), 1);
    const endRing = vertexStart + (ringCount - 1) * sides;
    for (let side = 0; side < sides; side++) {
      buffers.indices.push(endRing + side, endRing + (side + 1) % sides, capCenter);
    }
  }
}

function addLeaf(
  buffers: GeometryBuffers,
  center: Vector3,
  growthDirection: Vector3,
  halfWidth: number,
  halfLength: number,
  random: () => number,
  palette: readonly [Color3, Color3],
  brightness: number,
): void {
  const directionalGrowth = growthDirection.lengthSquared() > 0.001
    ? growthDirection.normalize()
    : randomUnitVector(random);
  const leafUp = directionalGrowth.scale(0.72)
    .add(Vector3.Up().scale(0.38))
    .add(randomUnitVector(random).scale(0.22))
    .normalize();
  const reference = Math.abs(leafUp.y) < 0.9 ? Vector3.Up() : Vector3.Right();
  const tangent = Vector3.Cross(leafUp, reference).normalize();
  const bitangent = Vector3.Cross(leafUp, tangent).normalize();
  const roll = random() * Math.PI * 2;
  const normal = tangent.scale(Math.cos(roll)).add(bitangent.scale(Math.sin(roll))).normalize();
  const leafRight = Vector3.Cross(normal, leafUp).normalize();

  const vertexStart = buffers.positions.length / 3;
  const leftScale = 0.9 + random() * 0.16;
  const rightScale = 0.9 + random() * 0.16;
  const tipDrift = (random() - 0.5) * halfWidth * 0.22;
  const ridge = normal.scale(halfLength * (0.045 + random() * 0.035));
  const edgeFold = normal.scale(-halfLength * (0.025 + random() * 0.025));

  const bladePoint = (across: number, along: number, folded = false): Vector3 => center
    .add(leafRight.scale(across))
    .add(leafUp.scale(along))
    .add(folded ? edgeFold : ridge);

  const points = [
    bladePoint(0, -halfLength * 0.82, false),
    bladePoint(-halfWidth * 0.72 * leftScale, -halfLength * 0.36, true),
    bladePoint(0, -halfLength * 0.36, false),
    bladePoint(halfWidth * 0.72 * rightScale, -halfLength * 0.36, true),
    bladePoint(-halfWidth * leftScale, halfLength * 0.04, true),
    bladePoint(0, halfLength * 0.04, false),
    bladePoint(halfWidth * rightScale, halfLength * 0.04, true),
    bladePoint(-halfWidth * 0.62 * leftScale, halfLength * 0.5, true),
    bladePoint(0, halfLength * 0.5, false),
    bladePoint(halfWidth * 0.62 * rightScale, halfLength * 0.5, true),
    bladePoint(tipDrift, halfLength, false),
  ];
  for (const point of points) buffers.positions.push(point.x, point.y, point.z);

  const edgeColor = scaleColor(mixColor(palette[0], palette[1], 0.28), brightness * 0.94);
  const innerColor = scaleColor(mixColor(palette[0], palette[1], 0.58), brightness);
  const veinColor = scaleColor(mixColor(palette[0], palette[1], 0.82), brightness * 1.04);
  const colors = [innerColor, edgeColor, veinColor, edgeColor, edgeColor, veinColor,
    edgeColor, edgeColor, veinColor, edgeColor, innerColor];
  for (const color of colors) pushColor(buffers.colors, color, 1);

  buffers.indices.push(
    vertexStart, vertexStart + 1, vertexStart + 2,
    vertexStart, vertexStart + 2, vertexStart + 3,
    vertexStart + 1, vertexStart + 4, vertexStart + 2,
    vertexStart + 2, vertexStart + 4, vertexStart + 5,
    vertexStart + 2, vertexStart + 5, vertexStart + 3,
    vertexStart + 3, vertexStart + 5, vertexStart + 6,
    vertexStart + 4, vertexStart + 7, vertexStart + 5,
    vertexStart + 5, vertexStart + 7, vertexStart + 8,
    vertexStart + 5, vertexStart + 8, vertexStart + 6,
    vertexStart + 6, vertexStart + 8, vertexStart + 9,
    vertexStart + 7, vertexStart + 10, vertexStart + 8,
    vertexStart + 8, vertexStart + 10, vertexStart + 9,
  );
}

function randomInUnitSphere(random: () => number): Vector3 {
  const direction = randomUnitVector(random);
  return direction.scale(Math.cbrt(random()));
}

function randomUnitVector(random: () => number): Vector3 {
  const y = random() * 2 - 1;
  const angle = random() * Math.PI * 2;
  const radius = Math.sqrt(1 - y * y);
  return new Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
}

function mixColor(from: Color3, to: Color3, amount: number): Color3 {
  return new Color3(
    lerp(from.r, to.r, amount),
    lerp(from.g, to.g, amount),
    lerp(from.b, to.b, amount),
  );
}

function scaleColor(color: Color3, scale: number): Color3 {
  return new Color3(
    Math.min(1, color.r * scale),
    Math.min(1, color.g * scale),
    Math.min(1, color.b * scale),
  );
}

function pushColor(target: number[], color: Color3, alpha: number): void {
  target.push(color.r, color.g, color.b, alpha);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
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
