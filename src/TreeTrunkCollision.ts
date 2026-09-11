import type { TreeSpecies } from "./procedural/ProceduralTree";

/**
 * Trunk collision profile of one species, in procedural source-model units
 * (a source tree is PROCEDURAL_TREE_SOURCE_HEIGHT tall). The radius is the
 * stem width at roughly waist height, where a walker actually meets the tree,
 * so it includes the butt swell but not the root flare on the ground.
 */
export interface TreeTrunkProfile {
  readonly radius: number;
  /** Share of the rendered height covered by solid stem before the crown. */
  readonly heightFraction: number;
}

export const TREE_TRUNK_PROFILES: Readonly<Record<TreeSpecies, TreeTrunkProfile>> = {
  acacia: { radius: 0.16, heightFraction: 0.54 },
  beech: { radius: 0.14, heightFraction: 0.62 },
  birch: { radius: 0.11, heightFraction: 1 },
  eucalyptus: { radius: 0.11, heightFraction: 0.76 },
  fir: { radius: 0.15, heightFraction: 1 },
  kapok: { radius: 0.19, heightFraction: 0.68 },
  mangrove: { radius: 0.16, heightFraction: 0.46 },
  maple: { radius: 0.15, heightFraction: 0.57 },
  oak: { radius: 0.2, heightFraction: 0.5 },
  palm: { radius: 0.15, heightFraction: 0.89 },
  pine: { radius: 0.15, heightFraction: 1 },
  spruce: { radius: 0.15, heightFraction: 1 },
};

/** One solid stem a walker cannot pass through. */
export interface TreeTrunk {
  /** Stem axis in the owning field's local frame. */
  readonly x: number;
  readonly z: number;
  /** Ground contact height of the stem. */
  readonly baseY: number;
  readonly radius: number;
  /** Height of solid stem above the base. */
  readonly height: number;
}

/** Horizontal body of the walker, positioned at the feet. */
export interface WalkerBody {
  readonly x: number;
  readonly z: number;
  readonly footY: number;
  readonly radius: number;
  readonly height: number;
}

export interface TrunkCollisionResult {
  x: number;
  z: number;
  /** True when at least one stem displaced the walker. */
  blocked: boolean;
}

/** Fixed-cell lookup of one field's trunks, populated while trees are placed. */
export class TreeTrunkIndex {
  private readonly cells = new Map<string, TreeTrunk[]>();
  private readonly cellSize: number;
  private maximumRadius = 0;
  private size = 0;

  constructor(cellSize: number) {
    if (!(cellSize > 0)) throw new RangeError("Trunk index cell size must be positive.");
    this.cellSize = cellSize;
  }

  get count(): number {
    return this.size;
  }

  add(trunk: TreeTrunk): void {
    const key = this.key(this.coordinate(trunk.x), this.coordinate(trunk.z));
    const cell = this.cells.get(key);
    if (cell) cell.push(trunk);
    else this.cells.set(key, [trunk]);
    this.maximumRadius = Math.max(this.maximumRadius, trunk.radius);
    this.size++;
  }

  /** Every trunk whose stem can lie within `radius` of a local position. */
  nearby(x: number, z: number, radius: number): TreeTrunk[] {
    if (this.size === 0) return [];
    const reach = radius + this.maximumRadius;
    const minimumX = this.coordinate(x - reach);
    const maximumX = this.coordinate(x + reach);
    const minimumZ = this.coordinate(z - reach);
    const maximumZ = this.coordinate(z + reach);
    const reachSquared = reach * reach;
    const result: TreeTrunk[] = [];
    for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ++) {
      for (let cellX = minimumX; cellX <= maximumX; cellX++) {
        const cell = this.cells.get(this.key(cellX, cellZ));
        if (!cell) continue;
        for (const trunk of cell) {
          const dx = trunk.x - x;
          const dz = trunk.z - z;
          if (dx * dx + dz * dz <= reachSquared) result.push(trunk);
        }
      }
    }
    return result;
  }

  private coordinate(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  private key(x: number, z: number): string {
    return `${x}:${z}`;
  }
}

/** A walker standing exactly on a stem axis has no contact normal; pick one. */
const DEGENERATE_CONTACT_DISTANCE = 1e-6;
/**
 * Placement jitter can set two wide stems closer than the body is wide. Each
 * pass then walks the body a little farther out of the wedge along the
 * bisector, converging within about ten passes; the loop exits early otherwise.
 */
const DEFAULT_RESOLUTION_PASSES = 12;

/**
 * Pushes a walker's body out of every stem it overlaps, treating each stem as
 * a vertical cylinder and the body as a vertical capsule of the same footprint.
 * Stems entirely above or below the body (a walker on a roof, a tree on a cliff
 * above) are ignored. Returns the settled position.
 */
export function resolveTreeTrunkCollisions(
  body: WalkerBody,
  trunks: readonly TreeTrunk[],
  passes = DEFAULT_RESOLUTION_PASSES,
): TrunkCollisionResult {
  let { x, z } = body;
  let blocked = false;
  const bodyTop = body.footY + body.height;
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const trunk of trunks) {
      if (body.footY >= trunk.baseY + trunk.height || bodyTop <= trunk.baseY) continue;
      const dx = x - trunk.x;
      const dz = z - trunk.z;
      const distance = Math.hypot(dx, dz);
      const contactDistance = trunk.radius + body.radius;
      if (distance >= contactDistance) continue;
      const normalX = distance < DEGENERATE_CONTACT_DISTANCE ? 1 : dx / distance;
      const normalZ = distance < DEGENERATE_CONTACT_DISTANCE ? 0 : dz / distance;
      x = trunk.x + normalX * contactDistance;
      z = trunk.z + normalZ * contactDistance;
      moved = true;
      blocked = true;
    }
    if (!moved) break;
  }
  return { x, z, blocked };
}
