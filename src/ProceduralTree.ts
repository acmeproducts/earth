import { Color3, Mesh, Scene, Vector3, VertexData } from "@babylonjs/core";
import {
  createVertexColorCaptureMaterial,
  getBirchBarkTexture,
} from "./ProceduralCaptureMaterial";
import { createSeededRandom } from "./Random";

export const PROCEDURAL_TREE_SOURCE_HEIGHT = 3;
export const PROCEDURAL_TREE_CAPTURE_DIAMETER = 3.2;

const BIRCH_LEAF_TEXTURE_URL = new URL(
  "../assets/vegetation/birch/leaf.png",
  import.meta.url,
).toString();

export interface ProceduralTreeOptions {
  seed?: number;
  name?: string;
  liveLighting?: boolean;
}

export type TreeSpecies = "birch" | "pine" | "spruce";

/** Species albedo correction applied only as the scene approaches night. */
export const TREE_LOW_LIGHT_BRIGHTNESS: Readonly<Record<TreeSpecies, number>> = {
  birch: 0.82,
  pine: 1.12,
  spruce: 1.35,
};

/** Shared contract for procedural trees that can be captured as impostors. */
export abstract class ProceduralTree {
  abstract readonly species: TreeSpecies;
  abstract readonly sourceHeight: number;
  abstract readonly captureDiameter: number;

  abstract create(scene: Scene, options?: ProceduralTreeOptions): Mesh;
}

export class BirchTree extends ProceduralTree {
  readonly species = "birch" as const;
  readonly sourceHeight = PROCEDURAL_TREE_SOURCE_HEIGHT;
  readonly captureDiameter = PROCEDURAL_TREE_CAPTURE_DIAMETER;

  create(scene: Scene, options: ProceduralTreeOptions = {}): Mesh {
    return createBirchTree(scene, options);
  }
}

export class PineTree extends ProceduralTree {
  readonly species = "pine" as const;
  readonly sourceHeight = PROCEDURAL_TREE_SOURCE_HEIGHT;
  readonly captureDiameter = 2.75;

  create(scene: Scene, options: ProceduralTreeOptions = {}): Mesh {
    return createConiferTree(scene, "pine", options);
  }
}

export class SpruceTree extends ProceduralTree {
  readonly species = "spruce" as const;
  readonly sourceHeight = PROCEDURAL_TREE_SOURCE_HEIGHT;
  readonly captureDiameter = 2.6;

  create(scene: Scene, options: ProceduralTreeOptions = {}): Mesh {
    return createConiferTree(scene, "spruce", options);
  }
}

export const TREE_SPECIES: Readonly<Record<TreeSpecies, ProceduralTree>> = {
  birch: new BirchTree(),
  pine: new PineTree(),
  spruce: new SpruceTree(),
};

interface GeometryBuffers {
  positions: number[];
  indices: number[];
  colors: number[];
  uvs: number[];
}

const BARK_TINT = new Color3(1, 1, 1);
const BARK_CUT = new Color3(0.22, 0.17, 0.105);
const LEAF_TINTS = [
  new Color3(0.82, 0.96, 0.68),
  new Color3(0.92, 1.0, 0.78),
  new Color3(0.72, 0.9, 0.58),
];

/** Builds one deterministic silver birch centered for directional impostor capture. */
export function createProceduralTree(
  scene: Scene,
  options: ProceduralTreeOptions = {},
): Mesh {
  return TREE_SPECIES.birch.create(scene, options);
}

function createBirchTree(
  scene: Scene,
  options: ProceduralTreeOptions = {},
): Mesh {
  const {
    seed = 0x54524545,
    name = "treeImpostorProceduralSource",
    liveLighting = false,
  } = options;
  const random = createSeededRandom(seed);
  const buffers: GeometryBuffers = { positions: [], indices: [], colors: [], uvs: [] };
  const foliageAnchors: Vector3[] = [];
  const trunkPoints: Vector3[] = [];
  const baseY = -PROCEDURAL_TREE_SOURCE_HEIGHT / 2;
  const trunkSegments = 11;

  for (let segment = 0; segment <= trunkSegments; segment++) {
    const t = segment / trunkSegments;
    trunkPoints.push(new Vector3(
      Math.sin(t * 5.1 + 0.4) * 0.026 * t,
      baseY + t * 2.86,
      Math.sin(t * 4.2 + 1.7) * 0.022 * t,
    ));
  }

  for (let segment = 0; segment < trunkSegments; segment++) {
    const t = segment / trunkSegments;
    addBranchSegment(
      buffers,
      trunkPoints[segment],
      trunkPoints[segment + 1],
      lerp(0.115, 0.022, Math.pow(t, 0.82)),
      lerp(0.108, 0.016, Math.pow((segment + 1) / trunkSegments, 0.82)),
      8,
      t,
    );
  }

  for (let root = 0; root < 4; root++) {
    const angle = root * Math.PI * 2 / 4 + 0.32;
    const direction = new Vector3(Math.cos(angle), 0, Math.sin(angle));
    const rootStart = trunkPoints[0].add(new Vector3(0, 0.12, 0));
    const rootMiddle = rootStart.add(direction.scale(0.11)).add(new Vector3(0, -0.04, 0));
    const rootEnd = rootStart.add(direction.scale(0.23 + Math.sin(root * 2.1) * 0.025))
      .add(new Vector3(0, -0.075, 0));
    addBranchSegment(buffers, rootStart, rootMiddle, 0.08, 0.05, 7, 0.02);
    addBranchSegment(buffers, rootMiddle, rootEnd, 0.05, 0.014, 6, 0.04, true);
  }

  for (const knot of [
    { level: 2, angle: 0.72, length: 0.042 },
    { level: 5, angle: 3.85, length: 0.032 },
  ]) {
    const heightT = knot.level / trunkSegments;
    const trunkRadius = lerp(0.115, 0.022, Math.pow(heightT, 0.82));
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
  for (let level = 3; level < trunkSegments; level++) {
    const branchesAtLevel = level < 7 ? 2 : 3;
    const start = trunkPoints[level];
    const crownT = (level - 3) / (trunkSegments - 3);
    const branchLength = lerp(0.72, 0.32, crownT) * (0.86 + random() * 0.24);

    for (let branch = 0; branch < branchesAtLevel; branch++) {
      const angle = level * goldenAngle + branch * Math.PI * 2 / branchesAtLevel + (random() - 0.5) * 0.3;
      const horizontal = new Vector3(Math.cos(angle), 0, Math.sin(angle));
      const middle = start.add(horizontal.scale(branchLength * 0.5))
        .add(new Vector3(0, branchLength * (0.3 + random() * 0.12), 0));
      const end = start.add(horizontal.scale(branchLength))
        .add(new Vector3(0, branchLength * (0.18 + random() * 0.16), 0));
      const branchRadius = lerp(0.04, 0.018, crownT) * (0.88 + random() * 0.2);
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
          .add(new Vector3(0, twigLength * (-0.12 + random() * 0.34), 0));
        addBranchSegment(buffers, middle, twigEnd, branchRadius * 0.4, branchRadius * 0.14, 5, crownT + 0.18);
        foliageAnchors.push(twigEnd);
      }
    }

    if (level >= 6) {
      foliageAnchors.push(start.add(new Vector3(
        (random() - 0.5) * 0.22,
        0.08 + random() * 0.12,
        (random() - 0.5) * 0.22,
      )));
    }
  }

  foliageAnchors.push(trunkPoints[trunkSegments].add(new Vector3(0, 0.2, 0)));
  for (const anchor of foliageAnchors) {
    const clusterScale = 0.82 + random() * 0.28;
    for (let leaf = 0; leaf < 18; leaf++) {
      const offset = randomInUnitSphere(random);
      const center = anchor.add(new Vector3(
        offset.x * 0.22 * clusterScale,
        offset.y * 0.28 * clusterScale,
        offset.z * 0.22 * clusterScale,
      ));
      const halfWidth = 0.052 + random() * 0.025;
      const halfLength = halfWidth * (0.76 + random() * 0.12);
      center.y = Math.min(PROCEDURAL_TREE_SOURCE_HEIGHT / 2 - halfLength, center.y);
      const tint = LEAF_TINTS[Math.floor(random() * LEAF_TINTS.length)];
      const brightness = 0.82 + random() * 0.22 + Math.max(0, center.y) * 0.025;
      addLeaf(
        buffers,
        center,
        offset,
        halfWidth,
        halfLength,
        random,
        tint,
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
  data.uvs = buffers.uvs;

  const tree = new Mesh(name, scene);
  data.applyToMesh(tree);
  tree.isPickable = false;
  tree.useVertexColors = true;
  tree.material = createVertexColorCaptureMaterial(
    scene,
    `${name}Material`,
    liveLighting,
    BIRCH_LEAF_TEXTURE_URL,
    getBirchBarkTexture(scene),
    TREE_LOW_LIGHT_BRIGHTNESS.birch,
  );
  return tree;
}

function createConiferTree(
  scene: Scene,
  species: "pine" | "spruce",
  options: ProceduralTreeOptions,
): Mesh {
  const {
    seed = species === "pine" ? 0x50494e45 : 0x53505255,
    name = `${species}ImpostorProceduralSource`,
    liveLighting = false,
  } = options;
  const random = createSeededRandom(seed);
  const buffers: GeometryBuffers = { positions: [], indices: [], colors: [], uvs: [] };
  const baseY = -PROCEDURAL_TREE_SOURCE_HEIGHT / 2;
  const trunkSegments = 14;
  const trunkPoints: Vector3[] = [];
  const bark = species === "pine"
    ? new Color3(0.34, 0.18, 0.075)
    : new Color3(0.25, 0.14, 0.07);
  const barkCut = new Color3(0.38, 0.25, 0.12);
  const needles = species === "pine"
    ? [new Color3(0.11, 0.29, 0.12), new Color3(0.16, 0.37, 0.16), new Color3(0.2, 0.42, 0.18)]
    : [new Color3(0.055, 0.2, 0.12), new Color3(0.075, 0.27, 0.16), new Color3(0.1, 0.32, 0.18)];

  for (let segment = 0; segment <= trunkSegments; segment++) {
    const t = segment / trunkSegments;
    trunkPoints.push(new Vector3(
      Math.sin(t * 4.7 + 0.8) * 0.018 * t,
      baseY + t * PROCEDURAL_TREE_SOURCE_HEIGHT,
      Math.sin(t * 3.9 + 2.1) * 0.015 * t,
    ));
  }
  for (let segment = 0; segment < trunkSegments; segment++) {
    const t = segment / trunkSegments;
    addBranchSegment(
      buffers,
      trunkPoints[segment],
      trunkPoints[segment + 1],
      lerp(0.13, 0.018, Math.pow(t, 0.78)),
      lerp(0.12, 0.009, Math.pow((segment + 1) / trunkSegments, 0.78)),
      7,
      t,
      false,
      bark,
      barkCut,
    );
  }

  const firstLevel = species === "pine" ? 5 : 2;
  for (let level = firstLevel; level < trunkSegments; level++) {
    const heightT = level / trunkSegments;
    const branches = 6;
    const crownT = (level - firstLevel) / (trunkSegments - firstLevel);
    const tierRadius = species === "pine"
      ? Math.sin(Math.min(1, crownT * 1.08) * Math.PI) * 0.55 + 0.32
      : lerp(0.92, 0.16, Math.pow(crownT, 0.72));

    for (let branch = 0; branch < branches; branch++) {
      const angle = level * 1.71 + branch * Math.PI * 2 / branches + (random() - 0.5) * 0.18;
      const horizontal = new Vector3(Math.cos(angle), 0, Math.sin(angle));
      const start = trunkPoints[level];
      const length = tierRadius * (0.84 + random() * 0.24);
      const droop = species === "spruce" ? -0.11 - length * 0.08 : 0.04 + random() * 0.08;
      const middle = start.add(horizontal.scale(length * 0.52)).add(new Vector3(0, droop * 0.35, 0));
      const end = start.add(horizontal.scale(length)).add(new Vector3(0, droop, 0));
      const radius = lerp(0.036, 0.012, heightT);
      addBranchSegment(buffers, start, middle, radius, radius * 0.62, 5, heightT, false, bark, barkCut);
      addBranchSegment(buffers, middle, end, radius * 0.62, radius * 0.16, 5, heightT, true, bark, barkCut);

      const sprays = species === "pine" ? 5 : 6;
      for (let spray = 0; spray < sprays; spray++) {
        const along = species === "pine" ? 0.7 + random() * 0.3 : 0.2 + random() * 0.8;
        const anchor = Vector3.Lerp(middle, end, along).add(new Vector3(
          (random() - 0.5) * 0.08,
          (random() - 0.5) * 0.07,
          (random() - 0.5) * 0.08,
        ));
        addNeedleSpray(
          buffers,
          anchor,
          horizontal,
          species === "pine" ? 0.15 : 0.12,
          species === "pine" ? 0.055 : 0.07,
          needles[Math.floor(random() * needles.length)],
          random,
        );
      }
    }
  }

  addNeedleSpray(
    buffers,
    trunkPoints[trunkSegments].add(new Vector3(0, -0.06, 0)),
    Vector3.Up(),
    species === "pine" ? 0.18 : 0.14,
    0.075,
    needles[1],
    random,
  );

  const data = new VertexData();
  const normals = new Float32Array(buffers.positions.length);
  VertexData.ComputeNormals(buffers.positions, buffers.indices, normals);
  data.positions = buffers.positions;
  data.indices = buffers.indices;
  data.normals = normals;
  data.colors = buffers.colors;
  data.uvs = buffers.uvs;
  const tree = new Mesh(name, scene);
  data.applyToMesh(tree);
  tree.isPickable = false;
  tree.useVertexColors = true;
  tree.material = createVertexColorCaptureMaterial(
    scene,
    `${name}Material`,
    liveLighting,
    undefined,
    undefined,
    TREE_LOW_LIGHT_BRIGHTNESS[species],
  );
  return tree;
}

function addNeedleSpray(
  buffers: GeometryBuffers,
  center: Vector3,
  growthDirection: Vector3,
  halfLength: number,
  halfWidth: number,
  tint: Color3,
  random: () => number,
): void {
  for (let card = 0; card < 3; card++) {
    const direction = growthDirection.add(randomUnitVector(random).scale(0.45)).normalize();
    addLeaf(
      buffers,
      center.add(randomUnitVector(random).scale(halfWidth * 0.35)),
      direction,
      halfWidth * (0.8 + random() * 0.35),
      halfLength * (0.82 + random() * 0.3),
      random,
      tint,
      0.82 + random() * 0.24,
    );
  }
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
  barkTint = BARK_TINT,
  barkCut = BARK_CUT,
): void {
  const vertexStart = buffers.positions.length / 3;
  const direction = end.subtract(start).normalize();
  const reference = Math.abs(direction.y) < 0.92 ? Vector3.Up() : Vector3.Right();
  const axisX = Vector3.Cross(direction, reference).normalize();
  const axisZ = Vector3.Cross(direction, axisX).normalize();
  const ringCount = 3;
  const ringStride = sides + 1;

  for (let ring = 0; ring < ringCount; ring++) {
    const ringT = ring / (ringCount - 1);
    const center = Vector3.Lerp(start, end, ringT);
    const radius = lerp(startRadius, endRadius, ringT) * (ring === 1 ? 1.035 : 1);
    for (let side = 0; side <= sides; side++) {
      const angle = Math.PI * 2 * side / sides + ringT * 0.09;
      const ridgeWave = Math.sin(angle * 3 + heightT * 10.5);
      const fineWave = Math.cos(angle * 5 - heightT * 7.2);
      const profileRadius = radius * (1 + ridgeWave * 0.055 + fineWave * 0.022);
      const point = center.add(axisX.scale(Math.cos(angle) * profileRadius))
        .add(axisZ.scale(Math.sin(angle) * profileRadius));
      buffers.positions.push(point.x, point.y, point.z);
      buffers.uvs.push(2 + side / sides, (heightT + ringT * 0.1) * 5);
      pushColor(buffers.colors, barkTint, 1);
    }
  }

  for (let ring = 0; ring < ringCount - 1; ring++) {
    for (let side = 0; side < sides; side++) {
      const bottom = vertexStart + ring * ringStride + side;
      const top = vertexStart + (ring + 1) * ringStride + side;
      buffers.indices.push(bottom, top, bottom + 1, bottom + 1, top, top + 1);
    }
  }

  if (endCap) {
    const capCenter = buffers.positions.length / 3;
    buffers.positions.push(end.x, end.y, end.z);
    buffers.uvs.push(-1, -1);
    pushColor(buffers.colors, barkCut, 1);
    const endRing = vertexStart + (ringCount - 1) * ringStride;
    for (let side = 0; side < sides; side++) {
      buffers.indices.push(endRing + side, endRing + side + 1, capCenter);
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
  tint: Color3,
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
  const points = [
    center.add(leafRight.scale(-halfWidth)).add(leafUp.scale(-halfLength)),
    center.add(leafRight.scale(halfWidth)).add(leafUp.scale(-halfLength)),
    center.add(leafRight.scale(halfWidth)).add(leafUp.scale(halfLength)),
    center.add(leafRight.scale(-halfWidth)).add(leafUp.scale(halfLength)),
  ];
  for (const point of points) buffers.positions.push(point.x, point.y, point.z);
  buffers.uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
  const leafColor = scaleColor(tint, brightness);
  for (let index = 0; index < 4; index++) pushColor(buffers.colors, leafColor, 1);
  buffers.indices.push(vertexStart, vertexStart + 1, vertexStart + 2,
    vertexStart, vertexStart + 2, vertexStart + 3);
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
