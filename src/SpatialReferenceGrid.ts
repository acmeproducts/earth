export interface SpatialReferenceGridEntry<T> {
  readonly x: number;
  readonly z: number;
  readonly value: T;
}

/** A fixed 2D grid which stores references without taking ownership of them. */
export class SpatialReferenceGrid<T> {
  private readonly cells = new Map<string, SpatialReferenceGridEntry<T>[]>();
  private readonly cellSize: number;

  public constructor(
    entries: readonly SpatialReferenceGridEntry<T>[],
    cellSize: number,
  ) {
    if (!(cellSize > 0)) throw new RangeError("Spatial grid cell size must be positive.");
    this.cellSize = cellSize;
    for (const entry of entries) this.add(entry);
  }

  /** Adds one reference, allowing large grids to be populated cooperatively. */
  public add(entry: SpatialReferenceGridEntry<T>): void {
    const cellX = this.coordinate(entry.x);
    const cellZ = this.coordinate(entry.z);
    const key = this.key(cellX, cellZ);
    const cell = this.cells.get(key);
    if (cell) cell.push(entry);
    else this.cells.set(key, [entry]);
  }

  /** Returns references in cells intersecting an annulus's conservative bounds. */
  public queryAnnulusBounds(
    centerX: number,
    centerZ: number,
    innerRadius: number,
    outerRadius: number,
  ): T[] {
    if (outerRadius < 0 || innerRadius > outerRadius) return [];
    const innerSquared = Math.max(0, innerRadius) ** 2;
    const outerSquared = outerRadius ** 2;
    const minimumX = this.coordinate(centerX - outerRadius);
    const maximumX = this.coordinate(centerX + outerRadius);
    const minimumZ = this.coordinate(centerZ - outerRadius);
    const maximumZ = this.coordinate(centerZ + outerRadius);
    const result: T[] = [];

    for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ++) {
      for (let cellX = minimumX; cellX <= maximumX; cellX++) {
        const cell = this.cells.get(this.key(cellX, cellZ));
        if (!cell || !this.cellIntersectsAnnulus(
          cellX,
          cellZ,
          centerX,
          centerZ,
          innerSquared,
          outerSquared,
        )) continue;
        for (const entry of cell) result.push(entry.value);
      }
    }
    return result;
  }

  private cellIntersectsAnnulus(
    cellX: number,
    cellZ: number,
    centerX: number,
    centerZ: number,
    innerSquared: number,
    outerSquared: number,
  ): boolean {
    const minimumX = cellX * this.cellSize;
    const maximumX = minimumX + this.cellSize;
    const minimumZ = cellZ * this.cellSize;
    const maximumZ = minimumZ + this.cellSize;
    const closestX = Math.max(minimumX, Math.min(centerX, maximumX));
    const closestZ = Math.max(minimumZ, Math.min(centerZ, maximumZ));
    const closestSquared = (closestX - centerX) ** 2 + (closestZ - centerZ) ** 2;
    if (closestSquared > outerSquared) return false;

    const farthestX = Math.max(Math.abs(minimumX - centerX), Math.abs(maximumX - centerX));
    const farthestZ = Math.max(Math.abs(minimumZ - centerZ), Math.abs(maximumZ - centerZ));
    return farthestX * farthestX + farthestZ * farthestZ >= innerSquared;
  }

  private coordinate(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  private key(x: number, z: number): string {
    return `${x}:${z}`;
  }
}
