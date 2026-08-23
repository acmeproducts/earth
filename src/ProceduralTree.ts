import { Color3, Mesh, Scene, Vector3, VertexData } from "@babylonjs/core";
import {
  createVertexColorCaptureMaterial,
  getTreeBarkTexture,
} from "./ProceduralCaptureMaterial";
import { createSeededRandom } from "./Random";

export const PROCEDURAL_TREE_SOURCE_HEIGHT = 3;
export const PROCEDURAL_TREE_CAPTURE_DIAMETER = 3.2;

export interface ProceduralTreeOptions {
  seed?: number;
  name?: string;
  liveLighting?: boolean;
}

export type TreeSpecies =
  | "acacia"
  | "beech"
  | "birch"
  | "eucalyptus"
  | "fir"
  | "mangrove"
  | "maple"
  | "oak"
  | "palm"
  | "pine"
  | "spruce";

export const TREE_SPECIES_LIST: readonly TreeSpecies[] = [
  "acacia", "beech", "birch", "eucalyptus", "fir", "mangrove",
  "maple", "oak", "palm", "pine", "spruce",
];

interface WebpackAssetContext {
  (path: string): string;
  keys(): string[];
}

const foliageTextureContext = (require as NodeRequire & {
  context(
    directory: string,
    useSubdirectories: boolean,
    pattern: RegExp,
  ): WebpackAssetContext;
}).context("../assets/vegetation", true, /^\.\/[^/]+\/foliage\.png$/);
const availableFoliageTextures = new Set(foliageTextureContext.keys());

const FOLIAGE_TEXTURE_URLS: Readonly<Partial<Record<TreeSpecies, string>>> =
  Object.fromEntries(TREE_SPECIES_LIST.flatMap((species) => {
    const path = `./${species}/foliage.png`;
    return availableFoliageTextures.has(path)
      ? [[species, foliageTextureContext(path)]]
      : [];
  }));

/**
 * A leaf image is one upright leaf on transparency: stem at the bottom, tip at
 * the top, which is the axis a card's own up direction already follows. Only
 * about half of such a card survives the alpha cut, so the card count the
 * flat-colored crown was tuned for leaves a see-through canopy behind it. More
 * cards fill it back in.
 */
const FOLIAGE_CARD_DENSITY = 2.6;
/** Leaves are taller than wide, so an unmeasured image is assumed to be too. */
const DEFAULT_FOLIAGE_CARD_ASPECT = 0.72;
const foliageCardAspects = new Map<TreeSpecies, number>();
let foliageMeasurement: Promise<void> | undefined;

/**
 * A card shaped unlike its image stretches the leaf drawn on it, so cards take
 * the image's own proportions. Measuring beats a table of numbers while the art
 * is still being iterated on: replacing a leaf reshapes its cards with it.
 * Geometry is built synchronously, so the async tree entry points resolve this
 * first; anything that builds a tree before it lands keeps the assumed shape.
 */
export function measureFoliageTextures(): Promise<void> {
  if (!foliageMeasurement) foliageMeasurement = measureEveryFoliageTexture();
  return foliageMeasurement;
}

function measureEveryFoliageTexture(): Promise<void> {
  if (typeof Image === "undefined") return Promise.resolve();
  const measurements = TREE_SPECIES_LIST.map((species) => {
    const url = FOLIAGE_TEXTURE_URLS[species];
    if (!url) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const image = new Image();
      // An unreadable image is one the material also drops, leaving cards flat
      // colored: their shape stops mattering, so measuring it does too.
      image.onerror = () => resolve();
      image.onload = () => {
        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
          foliageCardAspects.set(species, image.naturalWidth / image.naturalHeight);
        }
        resolve();
      };
      image.src = url;
    });
  });
  return Promise.all(measurements).then(() => undefined);
}

interface FoliageCardShape {
  /** Card width / length, matching the leaf image. */
  aspect: number;
  /** Card count multiplier that fills the crown back in after the alpha cut. */
  density: number;
}

/** Describes foliage cards only for species actually drawn with a leaf image. */
function foliageCardShape(species: TreeSpecies): FoliageCardShape | undefined {
  if (!FOLIAGE_TEXTURE_URLS[species]) return undefined;
  return {
    aspect: foliageCardAspects.get(species) ?? DEFAULT_FOLIAGE_CARD_ASPECT,
    density: FOLIAGE_CARD_DENSITY,
  };
}

/**
 * Reshapes a card to the leaf image's proportions without changing its area, so
 * a textured species keeps the crown volume its own sizing was tuned for.
 */
function shapeFoliageCard(
  halfWidth: number,
  halfLength: number,
  aspect?: number,
): { halfWidth: number; halfLength: number } {
  if (aspect === undefined) return { halfWidth, halfLength };
  const shapedHalfLength = Math.sqrt((halfWidth * halfLength) / aspect);
  return { halfWidth: shapedHalfLength * aspect, halfLength: shapedHalfLength };
}

/** Species albedo correction applied only as the scene approaches night. */
export const TREE_LOW_LIGHT_BRIGHTNESS: Readonly<Record<TreeSpecies, number>> = {
  acacia: 0.98,
  beech: 0.88,
  birch: 0.82,
  eucalyptus: 0.96,
  fir: 1.28,
  mangrove: 0.98,
  maple: 0.9,
  oak: 0.92,
  palm: 1.02,
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

export class FirTree extends ProceduralTree {
  readonly species = "fir" as const;
  readonly sourceHeight = PROCEDURAL_TREE_SOURCE_HEIGHT;
  readonly captureDiameter = 2.65;
  create(scene: Scene, options: ProceduralTreeOptions = {}): Mesh {
    return createConiferTree(scene, "fir", options);
  }
}

abstract class BroadleafTree extends ProceduralTree {
  readonly sourceHeight = PROCEDURAL_TREE_SOURCE_HEIGHT;
  abstract readonly species: BroadleafSpecies;
  create(scene: Scene, options: ProceduralTreeOptions = {}): Mesh {
    return createBroadleafTree(scene, this.species, options);
  }
}

export class AcaciaTree extends BroadleafTree {
  readonly species = "acacia" as const;
  readonly captureDiameter = 3.8;
}
export class BeechTree extends BroadleafTree {
  readonly species = "beech" as const;
  readonly captureDiameter = 3.25;
}
export class EucalyptusTree extends BroadleafTree {
  readonly species = "eucalyptus" as const;
  readonly captureDiameter = 2.65;
}
export class MangroveTree extends BroadleafTree {
  readonly species = "mangrove" as const;
  readonly captureDiameter = 3.5;
}
export class MapleTree extends BroadleafTree {
  readonly species = "maple" as const;
  readonly captureDiameter = 3.3;
}
export class OakTree extends BroadleafTree {
  readonly species = "oak" as const;
  readonly captureDiameter = 3.65;
}

export class PalmTree extends ProceduralTree {
  readonly species = "palm" as const;
  readonly sourceHeight = PROCEDURAL_TREE_SOURCE_HEIGHT;
  readonly captureDiameter = 2.85;
  create(scene: Scene, options: ProceduralTreeOptions = {}): Mesh {
    return createPalmTree(scene, options);
  }
}

export const TREE_SPECIES: Readonly<Record<TreeSpecies, ProceduralTree>> = {
  acacia: new AcaciaTree(),
  beech: new BeechTree(),
  birch: new BirchTree(),
  eucalyptus: new EucalyptusTree(),
  fir: new FirTree(),
  mangrove: new MangroveTree(),
  maple: new MapleTree(),
  oak: new OakTree(),
  palm: new PalmTree(),
  pine: new PineTree(),
  spruce: new SpruceTree(),
};

type BroadleafSpecies = "acacia" | "beech" | "eucalyptus" | "mangrove" | "maple" | "oak";

interface GeometryBuffers {
  positions: number[];
  indices: number[];
  colors: number[];
  uvs: number[];
}

const BARK_TINT = new Color3(1, 1, 1);
const BARK_CUT = new Color3(0.22, 0.17, 0.105);
const BIRCH_LEAF_TINTS = [
  new Color3(0.76, 0.86, 0.68),
  new Color3(0.84, 0.91, 0.75),
  new Color3(0.67, 0.8, 0.57),
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
  for (let level = 4; level < trunkSegments; level++) {
    const branchesAtLevel = level === trunkSegments - 1
      ? 3
      : level < 6 ? 3 : 4;
    const start = trunkPoints[level];
    const crownT = (level - 4) / (trunkSegments - 4);
    const branchLength = lerp(0.72, 0.32, crownT) * (0.86 + random() * 0.24);

    for (let branch = 0; branch < branchesAtLevel; branch++) {
      const angle = level * goldenAngle + branch * Math.PI * 2 / branchesAtLevel + (random() - 0.5) * 0.3;
      const horizontal = new Vector3(Math.cos(angle), 0, Math.sin(angle));
      const middle = start.add(horizontal.scale(branchLength * 0.5))
        .add(new Vector3(0, branchLength * (0.3 + random() * 0.12), 0));
      const end = start.add(horizontal.scale(branchLength))
        .add(new Vector3(0, branchLength * (0.18 + random() * 0.16), 0));
      const branchRadius = lerp(0.032, 0.0125, crownT) * (0.88 + random() * 0.2);
      const collarEnd = Vector3.Lerp(start, middle, 0.14);

      addBranchSegment(buffers, start, collarEnd, branchRadius * 1.28, branchRadius * 0.94, 7, crownT);
      addBranchSegment(buffers, collarEnd, middle, branchRadius * 0.92, branchRadius * 0.62, 6, crownT + 0.04);
      addBranchSegment(buffers, middle, end, branchRadius * 0.61, branchRadius * 0.22, 6, crownT + 0.12);
      foliageAnchors.push(end);

      for (const split of [-1, 1]) {
        const twigAngle = angle + split * (0.38 + random() * 0.3);
        const twigDirection = new Vector3(Math.cos(twigAngle), 0, Math.sin(twigAngle));
        const twigLength = branchLength * (0.27 + random() * 0.12);
        const twigEnd = middle.add(twigDirection.scale(twigLength))
          .add(new Vector3(0, twigLength * (-0.12 + random() * 0.34), 0));
        addBranchSegment(buffers, middle, twigEnd, branchRadius * 0.34, branchRadius * 0.1, 5, crownT + 0.18);
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
  const cards = foliageCardShape("birch");
  const leavesPerAnchor = Math.round(18 * (cards?.density ?? 1));
  for (const anchor of foliageAnchors) {
    const clusterScale = 0.82 + random() * 0.28;
    for (let leaf = 0; leaf < leavesPerAnchor; leaf++) {
      const offset = randomInUnitSphere(random);
      const center = anchor.add(new Vector3(
        offset.x * 0.22 * clusterScale,
        offset.y * 0.28 * clusterScale,
        offset.z * 0.22 * clusterScale,
      ));
      const cardWidth = 0.052 + random() * 0.025;
      const { halfWidth, halfLength } = shapeFoliageCard(
        cardWidth,
        cardWidth * (0.76 + random() * 0.12),
        cards?.aspect,
      );
      center.y = Math.min(PROCEDURAL_TREE_SOURCE_HEIGHT / 2 - halfLength, center.y);
      const tint = BIRCH_LEAF_TINTS[Math.floor(random() * BIRCH_LEAF_TINTS.length)];
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

  applyRegionalTreeCharacter(buffers, seed);

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
    FOLIAGE_TEXTURE_URLS.birch,
    getTreeBarkTexture(scene, "birch"),
    TREE_LOW_LIGHT_BRIGHTNESS.birch,
  );
  return tree;
}

interface BroadleafProfile {
  seed: number;
  trunkFraction: number;
  trunkRadius: number;
  crownRadius: number;
  crownDepth: number;
  branchCount: number;
  /** Rising leaders the trunk forks into; limbs grow from these, not the trunk. */
  leaderCount: number;
  /** Leaf cards for the whole crown, before any leaf-image multiplier. */
  foliageCards: number;
  bark: Color3;
  foliage: readonly Color3[];
}

const BROADLEAF_PROFILES: Readonly<Record<BroadleafSpecies, BroadleafProfile>> = {
  acacia: {
    seed: 0x41434143, trunkFraction: 0.54, trunkRadius: 0.14, crownRadius: 1.28,
    crownDepth: 0.34, branchCount: 11, leaderCount: 3, foliageCards: 650,
    bark: new Color3(0.3, 0.2, 0.1),
    foliage: [new Color3(0.3, 0.43, 0.12), new Color3(0.39, 0.5, 0.16)],
  },
  beech: {
    seed: 0x42454543, trunkFraction: 0.62, trunkRadius: 0.12, crownRadius: 0.95,
    crownDepth: 0.78, branchCount: 12, leaderCount: 2, foliageCards: 660,
    bark: new Color3(0.42, 0.4, 0.34),
    foliage: [new Color3(0.18, 0.42, 0.13), new Color3(0.28, 0.52, 0.18)],
  },
  eucalyptus: {
    seed: 0x45554341, trunkFraction: 0.76, trunkRadius: 0.095, crownRadius: 0.72,
    crownDepth: 0.82, branchCount: 9, leaderCount: 2, foliageCards: 330,
    bark: new Color3(0.42, 0.36, 0.27),
    foliage: [new Color3(0.25, 0.42, 0.3), new Color3(0.34, 0.5, 0.36)],
  },
  mangrove: {
    seed: 0x4d414e47, trunkFraction: 0.46, trunkRadius: 0.14, crownRadius: 1.02,
    crownDepth: 0.62, branchCount: 12, leaderCount: 3, foliageCards: 620,
    bark: new Color3(0.29, 0.2, 0.12),
    foliage: [new Color3(0.12, 0.36, 0.15), new Color3(0.2, 0.46, 0.2)],
  },
  maple: {
    seed: 0x4d41504c, trunkFraction: 0.57, trunkRadius: 0.13, crownRadius: 1.02,
    crownDepth: 0.82, branchCount: 13, leaderCount: 2, foliageCards: 760,
    bark: new Color3(0.3, 0.24, 0.17),
    foliage: [new Color3(0.2, 0.45, 0.12), new Color3(0.34, 0.56, 0.14)],
  },
  // The oak carries by far the heaviest crown of the family: a low fork into
  // three gnarled leaders, and enough cards that the canopy reads as solid mass
  // rather than as separate clumps hanging on the limb ends.
  oak: {
    seed: 0x4f414b21, trunkFraction: 0.5, trunkRadius: 0.18, crownRadius: 1.16,
    crownDepth: 0.72, branchCount: 17, leaderCount: 3, foliageCards: 2200,
    bark: new Color3(0.27, 0.19, 0.105),
    foliage: [new Color3(0.14, 0.36, 0.09), new Color3(0.25, 0.48, 0.12)],
  },
};

/** Builds the characteristic crown and branching profile of a broadleaf family. */
function createBroadleafTree(
  scene: Scene,
  species: BroadleafSpecies,
  options: ProceduralTreeOptions,
): Mesh {
  const profile = BROADLEAF_PROFILES[species];
  const {
    seed = profile.seed,
    name = `${species}ImpostorProceduralSource`,
    liveLighting = false,
  } = options;
  const random = createSeededRandom(seed);
  const buffers: GeometryBuffers = { positions: [], indices: [], colors: [], uvs: [] };
  const bark = profile.bark;
  const barkCut = scaleColor(profile.bark, 0.72);
  const baseY = -PROCEDURAL_TREE_SOURCE_HEIGHT / 2;
  const crownTop = PROCEDURAL_TREE_SOURCE_HEIGHT / 2;
  const trunkHeight = PROCEDURAL_TREE_SOURCE_HEIGHT * profile.trunkFraction;
  const trunkPoints: Vector3[] = [];
  const trunkSegments = 12;
  const trunkRadiusAt = (index: number): number => {
    const t = index / trunkSegments;
    // The butt swell is what separates a grown trunk from an extruded cylinder.
    return lerp(profile.trunkRadius, 0.038, Math.pow(t, 0.8)) * (1 + Math.pow(1 - t, 3) * 0.4);
  };

  // A trunk that leans one way the whole climb reads as a bent pole, so the sway
  // reverses on the way up with a finer wobble riding on it.
  for (let segment = 0; segment <= trunkSegments; segment++) {
    const t = segment / trunkSegments;
    const sway = species === "eucalyptus" ? 0.085 : 0.05;
    trunkPoints.push(new Vector3(
      (Math.sin(t * 3.8 + 0.5) + Math.sin(t * 9.4 + 1.1) * 0.3) * sway * t,
      baseY + trunkHeight * t,
      (Math.sin(t * 3.1 + 1.8) * 0.75 + Math.cos(t * 7.9) * 0.26) * sway * t,
    ));
  }
  for (let segment = 0; segment < trunkSegments; segment++) {
    addBranchSegment(
      buffers,
      trunkPoints[segment],
      trunkPoints[segment + 1],
      trunkRadiusAt(segment),
      trunkRadiusAt(segment + 1),
      9,
      segment / trunkSegments,
      false,
      bark,
      barkCut,
    );
  }

  // Mangroves stand on stilt roots instead of buttresses; everything else spreads
  // into the ground and carries the scars of limbs it has already shed.
  if (species === "mangrove") {
    const stiltLevel = Math.round(trunkSegments / 3);
    for (let root = 0; root < 9; root++) {
      const angle = root * Math.PI * 2 / 9 + random() * 0.2;
      const direction = new Vector3(Math.cos(angle), 0, Math.sin(angle));
      const start = trunkPoints[stiltLevel].add(direction.scale(profile.trunkRadius * 0.5));
      const middle = new Vector3(
        start.x + direction.x * (0.38 + random() * 0.15),
        baseY + 0.2 + random() * 0.08,
        start.z + direction.z * (0.38 + random() * 0.15),
      );
      const end = middle.add(direction.scale(0.18)).add(new Vector3(0, -0.2, 0));
      // Arch through the old knee rather than cornering at it.
      const stilt = curvePath(start, end, middle.subtract(Vector3.Lerp(start, end, 0.5)), 4);
      addLimbAlongPath(buffers, stilt, 0.05, 0.011, 6, 0.1, bark, barkCut);
    }
  } else {
    addRootFlares(
      buffers,
      trunkPoints[0],
      species === "eucalyptus" ? 5 : 6,
      profile.trunkRadius,
      profile.trunkRadius * (species === "eucalyptus" ? 1.7 : 2.5),
      bark,
      barkCut,
      random,
    );
  }
  addTrunkKnots(buffers, trunkPoints, trunkRadiusAt, [2, 5, 8], bark, barkCut, random);

  // Broadleaf crowns fork: the trunk divides into a few rising leaders and the
  // limbs come off those. Hanging every limb on one pole is what made these
  // crowns read as a mast with spars.
  const forkIndex = Math.floor(trunkSegments * 0.72);
  const forkBase = trunkPoints[forkIndex];
  const forkRadius = trunkRadiusAt(forkIndex);
  const leaderPaths: Vector3[][] = [];
  for (let leader = 0; leader < profile.leaderCount; leader++) {
    const angle = leader * Math.PI * 2 / profile.leaderCount + random() * 0.8;
    const reach = profile.crownRadius * (species === "acacia" ? 0.52 : 0.32)
      * (0.7 + random() * 0.55);
    const rise = (crownTop - forkBase.y)
      * (species === "acacia" ? 0.44 : 0.74) * (0.78 + random() * 0.3);
    const tip = forkBase.add(new Vector3(Math.cos(angle) * reach, rise, Math.sin(angle) * reach));
    // Pulling the mid-span back toward the trunk leaves the leader rising steeply
    // out of the fork before it swings outward, the way a real crotch grows.
    const path = curvePath(
      forkBase,
      tip,
      new Vector3(Math.cos(angle) * reach * -0.34, rise * 0.14, Math.sin(angle) * reach * -0.34),
      4,
    );
    addLimbAlongPath(
      buffers,
      path,
      forkRadius * (0.8 - leader * 0.07),
      0.026,
      8,
      0.5,
      bark,
      barkCut,
    );
    leaderPaths.push(path);
  }

  const tips: Vector3[] = leaderPaths.map((path) => path[path.length - 1]);
  for (let branch = 0; branch < profile.branchCount; branch++) {
    const ring = branch / profile.branchCount;
    const leaderPath = leaderPaths[branch % leaderPaths.length];
    const start = pointAlongPath(leaderPath, 0.22 + (branch * 0.37 + random() * 0.16) % 0.72);
    const angle = branch * Math.PI * (3 - Math.sqrt(5)) + random() * 0.25;
    const horizontal = new Vector3(Math.cos(angle), 0, Math.sin(angle));
    const radiusShape = species === "acacia"
      ? 0.78 + ring * 0.22
      : Math.sin((0.18 + ring * 0.72) * Math.PI) * 0.42 + 0.58;
    // A limb starting part way out a leaning leader is already partly there, so
    // spend the rest of the reach. Otherwise the crown grows past the width the
    // species declares for its capture frame and its terrain footprint.
    const startOffset = Math.hypot(start.x, start.z);
    const length = Math.max(
      profile.crownRadius * 0.2,
      profile.crownRadius * radiusShape * (0.72 + random() * 0.26) - startOffset * 0.85,
    );
    const vertical = species === "acacia"
      ? 0.12 + random() * 0.12
      : (random() - 0.2) * profile.crownDepth;
    const end = start.add(horizontal.scale(length)).add(new Vector3(0, vertical, 0));
    // Limbs leave the leader steeply, then level off under their own weight.
    const limbPath = curvePath(
      start,
      end,
      new Vector3(0, length * (species === "acacia" ? 0.12 : 0.24), 0)
        .add(horizontal.scale(length * -0.1)),
      3,
    );
    const branchRadius = lerp(forkRadius * 0.56, 0.024, ring);
    addLimbAlongPath(buffers, limbPath, branchRadius, 0.012, 6, 0.6, bark, barkCut);
    tips.push(end);

    for (const side of [-1, 1]) {
      const twigAngle = angle + side * (0.4 + random() * 0.36);
      const twigDirection = new Vector3(Math.cos(twigAngle), 0, Math.sin(twigAngle));
      const twigStart = pointAlongPath(limbPath, 0.48 + random() * 0.22);
      const twigLength = length * (0.34 + random() * 0.17);
      const twigEnd = twigStart.add(twigDirection.scale(twigLength))
        .add(new Vector3(0, vertical * 0.45 + (random() - 0.4) * 0.22, 0));
      const twigPath = curvePath(
        twigStart,
        twigEnd,
        new Vector3(0, twigLength * 0.18, 0),
        2,
      );
      addLimbAlongPath(buffers, twigPath, branchRadius * 0.46, 0.009, 5, 0.78, bark, barkCut);
      tips.push(twigEnd);

      // One more division at the ends. It costs little and it is what the eye
      // reads as branching rather than as bare spokes carrying leaf blobs.
      const spurDirection = new Vector3(
        Math.cos(twigAngle + side * (0.5 + random() * 0.4)),
        0,
        Math.sin(twigAngle + side * (0.5 + random() * 0.4)),
      );
      const spurEnd = twigEnd.add(spurDirection.scale(twigLength * (0.4 + random() * 0.24)))
        .add(new Vector3(0, (random() - 0.3) * 0.2, 0));
      addBranchSegment(
        buffers, twigEnd, spurEnd, branchRadius * 0.3, 0.007, 5, 0.86, true, bark, barkCut,
      );
      tips.push(spurEnd);
    }
  }

  // Spreading one crown-wide budget over however many tips the branching
  // produced keeps foliage a property of the species, not of the twig count.
  const cards = foliageCardShape(species);
  const cardBudget = Math.round(profile.foliageCards * (cards?.density ?? 1));
  const cardsPerTip = Math.max(4, Math.round(cardBudget / tips.length));
  for (const tip of tips) {
    const leafCount = cardsPerTip + Math.floor(random() * 5);
    for (let leaf = 0; leaf < leafCount; leaf++) {
      const offset = randomInUnitSphere(random);
      const flatness = species === "acacia" ? 0.22 : profile.crownDepth * 0.42;
      const center = tip.add(new Vector3(
        offset.x * profile.crownRadius * 0.23,
        offset.y * flatness,
        offset.z * profile.crownRadius * 0.23,
      ));
      center.y = Math.min(PROCEDURAL_TREE_SOURCE_HEIGHT / 2 - 0.04, center.y);
      const narrow = species === "eucalyptus" ? 1.75 : species === "acacia" ? 0.58 : 0.9;
      const cardWidth = (species === "eucalyptus" ? 0.035 : 0.052) * (0.82 + random() * 0.35);
      const card = shapeFoliageCard(cardWidth, cardWidth * narrow, cards?.aspect);
      addLeaf(
        buffers,
        center,
        offset,
        card.halfWidth,
        card.halfLength,
        random,
        profile.foliage[Math.floor(random() * profile.foliage.length)],
        0.82 + random() * 0.22,
      );
    }
  }

  applyRegionalTreeCharacter(buffers, seed);
  return createTreeMesh(scene, name, species, buffers, liveLighting);
}

/** Builds a ringed, gently leaning trunk with a radial crown of feathered fronds. */
function createPalmTree(scene: Scene, options: ProceduralTreeOptions): Mesh {
  const {
    seed = 0x50414c4d,
    name = "palmImpostorProceduralSource",
    liveLighting = false,
  } = options;
  const random = createSeededRandom(seed);
  const buffers: GeometryBuffers = { positions: [], indices: [], colors: [], uvs: [] };
  const baseY = -PROCEDURAL_TREE_SOURCE_HEIGHT / 2;
  const trunkTop = new Vector3(0.14, 1.16, -0.04);
  const trunkSegments = 15;
  const trunkBase = new Vector3(0, baseY, 0);
  let previous = trunkBase;
  const bark = new Color3(0.45, 0.29, 0.13);
  const barkCut = scaleColor(bark, 0.7);
  // A palm stem is not a taper: it swells into a root boss at the ground, holds
  // an almost constant width, then narrows into the crownshaft under the fronds.
  const stemRadiusAt = (t: number): number => lerp(0.115, 0.072, Math.pow(t, 0.55))
    * (1 + Math.pow(1 - t, 4) * 0.7)
    * (1 - Math.pow(t, 6) * 0.22);
  for (let segment = 0; segment < trunkSegments; segment++) {
    const t = (segment + 1) / trunkSegments;
    const from = segment / trunkSegments;
    const next = new Vector3(
      trunkTop.x * t + Math.sin(t * 5) * 0.018,
      lerp(baseY, trunkTop.y, t),
      trunkTop.z * t + Math.sin(t * 4 + 1.2) * 0.014,
    );
    // Old frond scars ring the stem, so the profile steps rather than sliding.
    const ring = 1 + Math.sin(t * trunkSegments * Math.PI) * 0.09;
    addBranchSegment(buffers, previous, next, stemRadiusAt(from) * ring,
      stemRadiusAt(t) * ring, 9, t, false, bark, barkCut);
    previous = next;
  }
  addRootFlares(buffers, trunkBase, 7, 0.115, 0.2, bark, barkCut, random);

  // Stubs of shed fronds hang below the living crown on most palms.
  for (let scar = 0; scar < 5; scar++) {
    const angle = scar * Math.PI * 2 / 5 + random() * 0.4;
    const direction = new Vector3(Math.cos(angle), -0.85 - random() * 0.5, Math.sin(angle))
      .normalize();
    const start = trunkTop.add(new Vector3(0, -0.1 - random() * 0.12, 0));
    addBranchSegment(
      buffers, start, start.add(direction.scale(0.12 + random() * 0.1)),
      0.022, 0.008, 5, 0.92, true, barkCut, barkCut,
    );
  }

  const frondColors = [new Color3(0.16, 0.4, 0.11), new Color3(0.25, 0.5, 0.13)];
  for (let frond = 0; frond < 13; frond++) {
    const angle = frond * Math.PI * 2 / 13 + random() * 0.16;
    const direction = new Vector3(Math.cos(angle), 0, Math.sin(angle));
    const length = 0.82 + random() * 0.22;
    const end = trunkTop.add(direction.scale(length)).add(new Vector3(0, -0.12 - random() * 0.18, 0));
    // A frond arches: it leaves the crown steeply and the tip hangs below the
    // chord. Two straight segments can only corner where the arch should be.
    const rachis = curvePath(trunkTop, end, new Vector3(0, 0.21 + random() * 0.07, 0), 5);
    const frondSpine = new Color3(0.23, 0.39, 0.08);
    addLimbAlongPath(buffers, rachis, 0.026, 0.004, 5, 0.9, frondSpine, frondSpine);
    for (let leaflet = 1; leaflet <= 11; leaflet++) {
      const along = leaflet / 12;
      const anchor = pointAlongPath(rachis, along);
      for (const side of [-1, 1]) {
        const lateral = new Vector3(-direction.z * side, -0.18, direction.x * side).normalize();
        addLeaf(buffers, anchor.add(lateral.scale(0.08)), lateral, 0.045,
          0.18 * (1 - Math.abs(along - 0.5) * 0.7), random,
          frondColors[frond % frondColors.length], 0.84 + random() * 0.18);
      }
    }
  }
  applyRegionalTreeCharacter(buffers, seed);
  return createTreeMesh(scene, name, "palm", buffers, liveLighting);
}

function createConiferTree(
  scene: Scene,
  species: "fir" | "pine" | "spruce",
  options: ProceduralTreeOptions,
): Mesh {
  const {
    seed = species === "pine" ? 0x50494e45 : species === "fir" ? 0x46495221 : 0x53505255,
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

  const trunkRadiusAt = (index: number): number => {
    const t = index / trunkSegments;
    return lerp(0.13, 0.014, Math.pow(t, 0.78)) * (1 + Math.pow(1 - t, 3) * 0.45);
  };

  for (let segment = 0; segment <= trunkSegments; segment++) {
    const t = segment / trunkSegments;
    trunkPoints.push(new Vector3(
      (Math.sin(t * 4.7 + 0.8) + Math.sin(t * 11.3) * 0.32) * 0.022 * t,
      baseY + t * PROCEDURAL_TREE_SOURCE_HEIGHT,
      (Math.sin(t * 3.9 + 2.1) + Math.cos(t * 9.7) * 0.28) * 0.019 * t,
    ));
  }
  for (let segment = 0; segment < trunkSegments; segment++) {
    addBranchSegment(
      buffers,
      trunkPoints[segment],
      trunkPoints[segment + 1],
      trunkRadiusAt(segment),
      trunkRadiusAt(segment + 1),
      7,
      segment / trunkSegments,
      false,
      bark,
      barkCut,
    );
  }

  const cards = foliageCardShape(species);
  const firstLevel = species === "pine" ? 4 : 2;
  addRootFlares(buffers, trunkPoints[0], 6, 0.13, 0.3, bark, barkCut, random);
  // Conifers shade out their own lower limbs and keep the dead stubs for years.
  // Below the first live whorl that bare stretch of trunk is all silhouette.
  for (let level = 1; level < firstLevel; level++) {
    const radius = trunkRadiusAt(level);
    for (let stub = 0; stub < 4; stub++) {
      const angle = level * 1.71 + stub * Math.PI * 0.5 + random() * 0.5;
      const direction = new Vector3(Math.cos(angle), -0.34 - random() * 0.3, Math.sin(angle))
        .normalize();
      const start = trunkPoints[level].add(direction.scale(radius * 0.6));
      const end = trunkPoints[level].add(direction.scale(radius + 0.07 + random() * 0.13));
      addBranchSegment(
        buffers, start, end, radius * 0.34, radius * 0.1, 5, level / trunkSegments,
        true, barkCut, barkCut,
      );
    }
  }
  for (let level = firstLevel; level < trunkSegments; level++) {
    const heightT = level / trunkSegments;
    // Pines grow in recognisable whorls, but a perfectly complete six-spoke
    // whorl looks manufactured once it is flattened into an impostor. Missing
    // limbs and alternating ring sizes keep the trunk visible and the crown
    // irregular without losing the species' characteristic tiering.
    const branches = species === "pine"
      ? 5 + (level % 3 === 0 ? 1 : 0)
      : species === "spruce"
        ? 7
        : 6;
    const crownT = (level - firstLevel) / (trunkSegments - firstLevel);
    const tierRadius = species === "pine"
      // A Swedish Scots pine does not build a spindle-shaped crown. Once its
      // shaded lower limbs have died, the first surviving whorl is normally
      // the widest and successive whorls shorten toward the leader.
      ? lerp(0.84, 0.14, Math.pow(crownT, 0.78))
      : lerp(0.92, 0.16, Math.pow(crownT, 0.72));

    for (let branch = 0; branch < branches; branch++) {
      const angle = level * 1.71 + branch * Math.PI * 2 / branches + (random() - 0.5) * 0.18;
      const horizontal = new Vector3(Math.cos(angle), 0, Math.sin(angle));
      const start = trunkPoints[level];
      // Keep pine's small whorl-to-whorl irregularity without allowing a high
      // tier to undo the crown's overall downward widening.
      const length = tierRadius * (species === "pine"
        ? 0.93 + random() * 0.1
        : 0.84 + random() * 0.24);
      const droop = species === "spruce"
        ? -0.11 - length * 0.08
        : species === "pine"
          ? 0.035 + crownT * 0.08 + random() * 0.055
          : 0.04 + random() * 0.08;
      const end = start.add(horizontal.scale(length)).add(new Vector3(0, droop, 0));
      const radius = lerp(0.036, 0.012, heightT);
      // A conifer limb leaves the trunk nearly level and turns near its tip: it
      // rises before hanging on a spruce, and sweeps up on a fir or pine.
      const limbPath = curvePath(
        start,
        end,
        new Vector3(0, species === "spruce" ? length * 0.16 : -length * 0.1, 0),
        3,
      );
      addLimbAlongPath(buffers, limbPath, radius, radius * 0.14, 5, heightT, bark, barkCut);

      const sprays = species === "pine" ? 5 : species === "spruce" ? 8 : 6;
      for (let spray = 0; spray < sprays; spray++) {
        const along = species === "pine"
          ? 0.48 + spray * 0.115 + random() * 0.035
          : species === "spruce"
            ? 0.14 + spray * 0.095 + random() * 0.04
            : 0.2 + random() * 0.8;
        const anchor = pointAlongPath(limbPath, along).add(new Vector3(
          (random() - 0.5) * (species === "pine" ? 0.025 : 0.08),
          (random() - 0.5) * (species === "pine" ? 0.025 : 0.07),
          (random() - 0.5) * (species === "pine" ? 0.025 : 0.08),
        ));
        if (species === "pine") {
          addPineNeedleTuft(
            buffers, anchor, horizontal, needles[Math.floor(random() * needles.length)],
            random, cards,
          );
        } else {
          addNeedleSpray(
            buffers, anchor, horizontal, 0.12, 0.07,
            needles[Math.floor(random() * needles.length)], random, cards,
          );
        }
      }

      // Foliage belongs on a feathered system of woody twigs, not in blobs along
      // a bare radial pole. Pine twigs sweep outward and up; spruce twigs spread
      // laterally and hang. Fir retains its simpler, compact branch structure.
      const branchletCount = species === "pine" ? 5 : species === "spruce" ? 3 : 1;
      const lateral = new Vector3(-horizontal.z, 0, horizontal.x);
      for (let branchlet = 0; branchlet < branchletCount; branchlet++) {
        const along = species === "pine"
          ? 0.3 + branchlet * 0.13 + random() * 0.055
          : species === "spruce"
            ? 0.2 + branchlet * 0.18 + random() * 0.06
            : 0.4 + random() * 0.07;
        const branchletStart = pointAlongPath(limbPath, along);
        const branchletLength = length * (species === "pine"
          ? 0.34 - branchlet * 0.035 + random() * 0.05
          : species === "spruce"
            ? 0.24 + (1 - along) * 0.16 + random() * 0.06
            : 0.34 + random() * 0.2);
        const side = branchlet % 2 === 0 ? 1 : -1;
        const branchletAngle = angle + (random() - 0.5) * 1.2;
        const branchletDirection = species === "pine"
          ? horizontal.scale(0.65).add(lateral.scale(side * (0.62 + random() * 0.16))).normalize()
          : species === "spruce"
            ? horizontal.scale(0.42).add(lateral.scale(side * (0.82 + random() * 0.16))).normalize()
          : new Vector3(
            Math.cos(branchletAngle), 0, Math.sin(branchletAngle),
          );
        const branchletEnd = branchletStart.add(branchletDirection.scale(branchletLength))
          .add(new Vector3(
            0,
            species === "pine"
              ? 0.025 + random() * 0.045
              : species === "spruce"
                ? -0.025 - branchletLength * 0.12
                : droop * 0.55,
            0,
          ));
        const branchletPath = curvePath(
          branchletStart,
          branchletEnd,
          new Vector3(
            0,
            species === "pine"
              ? -branchletLength * 0.045
              : species === "spruce"
                ? branchletLength * 0.08
                : 0,
            0,
          ),
          species === "pine" || species === "spruce" ? 2 : 1,
        );
        addLimbAlongPath(
          buffers, branchletPath, radius * 0.42, radius * 0.09, 5, heightT,
          bark, barkCut,
        );
        if (species === "pine") {
          addPineNeedleTuft(
            buffers, branchletEnd, branchletDirection,
            needles[Math.floor(random() * needles.length)], random, cards,
          );
        } else {
          const branchletSprays = species === "spruce" ? 3 : 2;
          for (let spray = 0; spray < branchletSprays; spray++) {
            addNeedleSpray(
              buffers,
              pointAlongPath(
                branchletPath,
                0.32 + spray / branchletSprays * 0.62 + random() * 0.08,
              ),
              branchletDirection,
              species === "spruce" ? 0.115 : 0.1,
              species === "spruce" ? 0.068 : 0.062,
              needles[Math.floor(random() * needles.length)], random, cards,
            );
          }
        }
      }
    }
  }

  if (species === "pine") {
    addPineNeedleTuft(
      buffers, trunkPoints[trunkSegments].add(new Vector3(0, -0.06, 0)),
      Vector3.Up(), needles[1], random, cards, 1.18,
    );
  } else {
    addNeedleSpray(
      buffers, trunkPoints[trunkSegments].add(new Vector3(0, -0.06, 0)),
      Vector3.Up(), 0.14, 0.075, needles[1], random, cards,
    );
  }

  applyRegionalTreeCharacter(buffers, seed);

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
    FOLIAGE_TEXTURE_URLS[species],
    getTreeBarkTexture(scene, species),
    TREE_LOW_LIGHT_BRIGHTNESS[species],
  );
  return tree;
}

/** Gives sister variants a different large-scale silhouette, not just different twigs. */
function applyRegionalTreeCharacter(buffers: GeometryBuffers, seed: number): void {
  const random = createSeededRandom(seed ^ 0x56415249);
  const widthScale = 0.76 + random() * 0.48;
  const depthScale = 0.76 + random() * 0.48;
  const crownLeanAngle = random() * Math.PI * 2;
  const crownLeanDistance = random() * 0.18;
  const crownLeanX = Math.cos(crownLeanAngle) * crownLeanDistance;
  const crownLeanZ = Math.sin(crownLeanAngle) * crownLeanDistance;
  const foliageRed = 0.9 + random() * 0.2;
  const foliageGreen = 0.91 + random() * 0.18;
  const foliageBlue = 0.88 + random() * 0.24;
  const baseY = -PROCEDURAL_TREE_SOURCE_HEIGHT / 2;

  for (let offset = 0; offset < buffers.positions.length; offset += 3) {
    const height01 = Math.max(0, Math.min(
      1,
      (buffers.positions[offset + 1] - baseY) / PROCEDURAL_TREE_SOURCE_HEIGHT,
    ));
    // Keep regional asymmetry in the canopy. Starting the deformation near the
    // crown avoids turning an otherwise upright trunk into a deeply bent stem.
    const crown = smoothstep01((height01 - 0.45) / 0.55);
    buffers.positions[offset] = buffers.positions[offset] * lerp(1, widthScale, crown)
      + crownLeanX * crown;
    buffers.positions[offset + 2] = buffers.positions[offset + 2] * lerp(1, depthScale, crown)
      + crownLeanZ * crown;

    const vertex = offset / 3;
    const textureU = buffers.uvs[vertex * 2] ?? -1;
    if (textureU < 0 || textureU >= 1.5) continue;
    const color = vertex * 4;
    buffers.colors[color] = Math.min(1, buffers.colors[color] * foliageRed);
    buffers.colors[color + 1] = Math.min(1, buffers.colors[color + 1] * foliageGreen);
    buffers.colors[color + 2] = Math.min(1, buffers.colors[color + 2] * foliageBlue);
  }
}

function smoothstep01(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function createTreeMesh(
  scene: Scene,
  name: string,
  species: TreeSpecies,
  buffers: GeometryBuffers,
  liveLighting: boolean,
): Mesh {
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
    FOLIAGE_TEXTURE_URLS[species],
    getTreeBarkTexture(scene, species),
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
  cards?: FoliageCardShape,
): void {
  const cardCount = Math.round(3 * (cards?.density ?? 1));
  for (let card = 0; card < cardCount; card++) {
    const direction = growthDirection.add(randomUnitVector(random).scale(0.45)).normalize();
    const size = shapeFoliageCard(
      halfWidth * (0.8 + random() * 0.35),
      halfLength * (0.82 + random() * 0.3),
      cards?.aspect,
    );
    addLeaf(
      buffers,
      center.add(randomUnitVector(random).scale(halfWidth * 0.35)),
      direction,
      size.halfWidth,
      size.halfLength,
      random,
      tint,
      0.82 + random() * 0.24,
    );
  }
}

/**
 * A feathered pine shoot. The texture already depicts a complete needled twig,
 * so only a few crossed cards are needed. Stacking density-multiplied cards at
 * one point makes each branch end read as a round pom-pom.
 */
function addPineNeedleTuft(
  buffers: GeometryBuffers,
  center: Vector3,
  growthDirection: Vector3,
  tint: Color3,
  random: () => number,
  cards?: FoliageCardShape,
  scale = 1,
): void {
  const cardCount = 3;
  const shootDirection = growthDirection.lengthSquared() > 0.001
    ? growthDirection.normalize()
    : Vector3.Up();
  for (let card = 0; card < cardCount; card++) {
    const along = (card / (cardCount - 1) - 0.36) * 0.07 * scale;
    const direction = shootDirection
      .add(Vector3.Up().scale(0.07 + random() * 0.07))
      .add(randomUnitVector(random).scale(0.055))
      .normalize();
    const size = shapeFoliageCard(
      0.034 * scale * (0.9 + random() * 0.16),
      0.112 * scale * (0.9 + random() * 0.16),
      cards?.aspect,
    );
    addLeaf(
      buffers,
      center.add(shootDirection.scale(along))
        .add(randomUnitVector(random).scale(0.006 * scale)),
      direction,
      size.halfWidth,
      size.halfLength,
      random,
      tint,
      0.88 + random() * 0.18,
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

/** Samples a quadratic curve whose mid-span is displaced by `bend`. */
function curvePath(start: Vector3, end: Vector3, bend: Vector3, spans: number): Vector3[] {
  const control = Vector3.Lerp(start, end, 0.5).add(bend);
  const path: Vector3[] = [];
  for (let span = 0; span <= spans; span++) {
    const t = span / spans;
    const inverse = 1 - t;
    path.push(
      start.scale(inverse * inverse)
        .add(control.scale(2 * inverse * t))
        .add(end.scale(t * t)),
    );
  }
  return path;
}

/** Position at a normalized distance along a sampled path. */
function pointAlongPath(path: Vector3[], t: number): Vector3 {
  const scaled = Math.min(1, Math.max(0, t)) * (path.length - 1);
  const span = Math.min(path.length - 2, Math.floor(scaled));
  return Vector3.Lerp(path[span], path[span + 1], scaled - span);
}

/**
 * Grows a limb along a path, thickened into a collar where it leaves its parent
 * and tapering to a tip. A straight cylinder of constant radius reads as a stick
 * glued on; the bend of the path, the collar and the taper are what make the
 * join look grown.
 */
function addLimbAlongPath(
  buffers: GeometryBuffers,
  path: Vector3[],
  startRadius: number,
  endRadius: number,
  sides: number,
  heightT: number,
  bark: Color3,
  barkCut: Color3,
): void {
  const spans = path.length - 1;
  for (let span = 0; span < spans; span++) {
    const from = span / spans;
    const to = (span + 1) / spans;
    const collar = span === 0 ? 1.34 : 1;
    addBranchSegment(
      buffers,
      path[span],
      path[span + 1],
      lerp(startRadius, endRadius, Math.pow(from, 0.7)) * collar,
      lerp(startRadius, endRadius, Math.pow(to, 0.7)),
      sides,
      heightT + to * 0.12,
      span === spans - 1,
      bark,
      barkCut,
    );
  }
}

/**
 * Buttress flares that spread into the ground. Without them a trunk ends in a
 * cut cylinder floating on the terrain, which is the single clearest tell that
 * the tree was extruded rather than grown.
 */
function addRootFlares(
  buffers: GeometryBuffers,
  base: Vector3,
  count: number,
  trunkRadius: number,
  reach: number,
  bark: Color3,
  barkCut: Color3,
  random: () => number,
): void {
  for (let root = 0; root < count; root++) {
    const angle = root * Math.PI * 2 / count + (random() - 0.5) * 0.5;
    const direction = new Vector3(Math.cos(angle), 0, Math.sin(angle));
    const rise = trunkRadius * (1.1 + random() * 0.8);
    const start = base.add(new Vector3(0, rise, 0));
    const end = start.add(direction.scale(reach * (0.85 + random() * 0.35)))
      .add(new Vector3(0, -rise * 1.05, 0));
    const flare = curvePath(start, end, direction.scale(reach * 0.22), 3);
    addLimbAlongPath(
      buffers,
      flare,
      trunkRadius * (0.52 + random() * 0.16),
      trunkRadius * 0.1,
      7,
      0.02,
      bark,
      barkCut,
    );
  }
}

/**
 * Stubs left where limbs were shed. A bare trunk between the roots and the crown
 * is the emptiest part of the silhouette, and these break it up.
 */
function addTrunkKnots(
  buffers: GeometryBuffers,
  trunkPoints: Vector3[],
  radiusAt: (index: number) => number,
  levels: readonly number[],
  bark: Color3,
  barkCut: Color3,
  random: () => number,
): void {
  for (const level of levels) {
    if (level >= trunkPoints.length) continue;
    const radius = radiusAt(level);
    const angle = random() * Math.PI * 2;
    const direction = new Vector3(
      Math.cos(angle),
      0.14 + random() * 0.34,
      Math.sin(angle),
    ).normalize();
    const start = trunkPoints[level].add(direction.scale(radius * 0.7));
    const end = trunkPoints[level].add(direction.scale(radius + radius * (0.5 + random() * 1.1)));
    addBranchSegment(
      buffers,
      start,
      end,
      radius * 0.44,
      radius * 0.19,
      7,
      level / trunkPoints.length,
      true,
      bark,
      barkCut,
    );
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
