import { VertexBuffer, VertexData } from "@babylonjs/core";
import type { Mesh } from "@babylonjs/core";
import {
  clipHalfPlane,
  clipToBounds,
  polygonArea,
  signedArea,
  type PlanarPoint,
} from "../core/PlanarGeometry";

/**
 * The exact triangle grid Babylon's ground mesh renders for one terrain tile.
 *
 * Decal geometry such as road surfaces cannot be placed on an idealized
 * heightfield: the ground is drawn as flat triangles, so any surface derived
 * from bilinear samples or from a plan's own grade will cut through it wherever
 * the two disagree. This reads back the terrain mesh's own vertices and exposes
 * the rendered surface itself, so decals can be split along the same triangles
 * and can never sink into the ground between samples.
 */
export class TerrainSurface {
  /** Vertex heights in scene units, row-major from north to south. */
  private readonly heights: Float32Array;
  readonly subdivisions: number;
  readonly meshWidth: number;
  readonly meshDepth: number;
  private readonly cellWidth: number;
  private readonly cellDepth: number;
  private normals?: Float32Array;

  constructor(
    heights: Float32Array,
    subdivisions: number,
    meshWidth: number,
    meshDepth: number,
    normals?: Float32Array,
  ) {
    this.heights = heights;
    this.subdivisions = subdivisions;
    this.meshWidth = meshWidth;
    this.meshDepth = meshDepth;
    this.cellWidth = meshWidth / subdivisions;
    this.cellDepth = meshDepth / subdivisions;
    this.normals = normals;
  }

  /** Reads the rendered vertices of a ground built by createTerrainMesh. */
  static fromGroundMesh(
    mesh: Mesh,
    meshWidth: number,
    meshDepth: number,
  ): TerrainSurface | undefined {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) return undefined;
    const verticesPerRow = Math.round(Math.sqrt(positions.length / 3));
    if (verticesPerRow < 2 || verticesPerRow * verticesPerRow * 3 !== positions.length) {
      return undefined;
    }
    const heights = new Float32Array(verticesPerRow * verticesPerRow);
    for (let index = 0; index < heights.length; index++) {
      heights[index] = positions[index * 3 + 1];
    }
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
    return new TerrainSurface(
      heights, verticesPerRow - 1, meshWidth, meshDepth,
      normals ? new Float32Array(normals) : undefined,
    );
  }

  columnAt(x: number): number {
    return (x / this.meshWidth + 0.5) * this.subdivisions;
  }

  rowAt(z: number): number {
    return (0.5 - z / this.meshDepth) * this.subdivisions;
  }

  private xAt(column: number): number {
    return (column / this.subdivisions - 0.5) * this.meshWidth;
  }

  private zAt(row: number): number {
    return (0.5 - row / this.subdivisions) * this.meshDepth;
  }

  private height(column: number, row: number): number {
    return this.heights[row * (this.subdivisions + 1) + column];
  }

  /** Height of the rendered ground in scene units, exact on every triangle. */
  heightAt(point: PlanarPoint): number {
    const column = clampCell(Math.floor(this.columnAt(point.x)), this.subdivisions);
    const row = clampCell(Math.floor(this.rowAt(point.z)), this.subdivisions);
    return this.planeAt(column, row, this.diagonalSide(column, row, point))(point);
  }

  /** Interpolates the ground's smooth vertex normals across its actual triangles. */
  normalAt(point: PlanarPoint): { x: number; y: number; z: number } {
    const normals = this.normals ??= this.computeNormals();
    const column = clampCell(Math.floor(this.columnAt(point.x)), this.subdivisions);
    const row = clampCell(Math.floor(this.rowAt(point.z)), this.subdivisions);
    const across = Math.max(0, Math.min(1, this.columnAt(point.x) - column));
    const along = Math.max(0, Math.min(1, this.rowAt(point.z) - row));
    const stride = this.subdivisions + 1;
    const northWest = row * stride + column;
    const southEast = northWest + stride + 1;
    const upper = across >= along;
    const corner = upper ? northWest + 1 : northWest + stride;
    const firstWeight = 1 - Math.max(across, along);
    const cornerWeight = Math.abs(across - along);
    const lastWeight = Math.min(across, along);
    const component = (axis: number) => normals[northWest * 3 + axis] * firstWeight +
      normals[corner * 3 + axis] * cornerWeight + normals[southEast * 3 + axis] * lastWeight;
    const x = component(0);
    const y = component(1);
    const z = component(2);
    const length = Math.hypot(x, y, z) || 1;
    return { x: x / length, y: y / length, z: z / length };
  }

  private computeNormals(): Float32Array {
    const positions = new Float32Array(this.heights.length * 3);
    const indices: number[] = [];
    const stride = this.subdivisions + 1;
    for (let row = 0; row <= this.subdivisions; row++) {
      for (let column = 0; column <= this.subdivisions; column++) {
        const index = row * stride + column;
        positions.set([this.xAt(column), this.height(column, row), this.zAt(row)], index * 3);
        if (row < this.subdivisions && column < this.subdivisions) {
          indices.push(index, index + stride + 1, index + 1,
            index, index + stride, index + stride + 1);
        }
      }
    }
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, indices, normals);
    return normals;
  }

  /**
   * Splits a polygon along the ground triangles it covers so every returned
   * piece lies within a single flat triangle of the rendered terrain.
   */
  splitByGroundTriangles(polygon: readonly PlanarPoint[]): TerrainSurfacePiece[] {
    const pieces: TerrainSurfacePiece[] = [];
    for (const piece of this.groundTrianglePieces(polygon)) if (piece) pieces.push(piece);
    return pieces;
  }

  /** Undefined marks a bounded work slice, including cells outside the polygon.
   * Streaming consumers can yield even while scanning a long diagonal's empty
   * bounding-box cells; synchronous callers retain the exact same geometry.
   */
  *groundTrianglePieces(polygon: readonly PlanarPoint[]): Generator<TerrainSurfacePiece | undefined> {
    if (polygon.length < 3) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const point of polygon) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    const firstColumn = clampCell(Math.floor(this.columnAt(minX)), this.subdivisions);
    const lastColumn = clampCell(Math.ceil(this.columnAt(maxX)) - 1, this.subdivisions);
    const firstRow = clampCell(Math.floor(this.rowAt(maxZ)), this.subdivisions);
    const lastRow = clampCell(Math.ceil(this.rowAt(minZ)) - 1, this.subdivisions);
    let cells = 0;
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        if ((cells++ & 31) === 0) yield undefined;
        const cell = clipToBounds(polygon, {
          minX: this.xAt(column),
          maxX: this.xAt(column + 1),
          minZ: this.zAt(row + 1),
          maxZ: this.zAt(row),
        });
        if (cell.length < 3) continue;
        const corner = { x: this.xAt(column), z: this.zAt(row) };
        const opposite = { x: this.xAt(column + 1), z: this.zAt(row + 1) };
        for (const upper of [true, false]) {
          const outline = clipHalfPlane(cell, corner, opposite, upper);
          if (outline.length < 3 || polygonArea(outline) <= AREA_EPSILON) continue;
          yield { outline, height: this.planeAt(column, row, upper) };
        }
      }
    }
  }

  /** True on the triangle holding the cell's north-east corner. */
  private diagonalSide(column: number, row: number, point: PlanarPoint): boolean {
    const across = (point.x - this.xAt(column)) / this.cellWidth;
    const along = (this.zAt(row) - point.z) / this.cellDepth;
    return across >= along;
  }

  private planeAt(
    column: number,
    row: number,
    upper: boolean,
  ): (point: PlanarPoint) => number {
    const originX = this.xAt(column);
    const originZ = this.zAt(row);
    const northWest = this.height(column, row);
    const northEast = this.height(column + 1, row);
    const southWest = this.height(column, row + 1);
    const southEast = this.height(column + 1, row + 1);
    // Babylon splits each ground cell along its north-west to south-east
    // diagonal, so the two triangles interpolate through different corners.
    const perColumn = upper ? northEast - northWest : southEast - southWest;
    const perRow = upper ? southEast - northEast : southWest - northWest;
    const cellWidth = this.cellWidth;
    const cellDepth = this.cellDepth;
    return (point) => northWest +
      perColumn * (point.x - originX) / cellWidth +
      perRow * (originZ - point.z) / cellDepth;
  }
}

/** One convex fragment of a decal, wholly inside a single ground triangle. */
export interface TerrainSurfacePiece {
  outline: PlanarPoint[];
  height: (point: PlanarPoint) => number;
}

const AREA_EPSILON = 1e-12;

function clampCell(value: number, subdivisions: number): number {
  return Math.max(0, Math.min(subdivisions - 1, value));
}

/** One vertex of a conformed decal, in scene units. */
export interface DecalVertex {
  x: number;
  y: number;
  z: number;
}

/**
 * Lays a flat decal polygon onto the rendered ground.
 *
 * Each returned ring lies within one ground triangle and is wound so its face
 * points up. Vertex heights take the higher of the caller's planned surface
 * and the ground itself, so over every fragment the decal is the upper
 * envelope of two planes. That envelope is convex, and a convex function is
 * bounded above by the linear interpolation of its values at a triangle's
 * corners, so no point of the emitted geometry can sink below the ground.
 * With followGround, use the ground plane directly when available; surface
 * roads must not float over valleys that their limited earthwork preserves.
 */
export function conformDecalPolygon(
  outline: readonly PlanarPoint[],
  plannedHeight: (point: PlanarPoint) => number,
  clearance: number,
  surface?: TerrainSurface,
  followGround = false,
): DecalVertex[][] {
  if (outline.length < 3) return [];
  const pieces: TerrainSurfacePiece[] = surface
    ? surface.splitByGroundTriangles(outline)
    : [{ outline: [...outline], height: () => -Infinity }];
  const rings: DecalVertex[][] = [];
  for (const piece of pieces) {
    if (piece.outline.length >= 3) rings.push(conformDecalPiece(piece, plannedHeight, clearance, followGround && !!surface));
  }
  return rings;
}

/** Same decal as the synchronous path, with bounded terrain-cell slices. */
export async function conformDecalPolygonAsync(
  outline: readonly PlanarPoint[],
  plannedHeight: (point: PlanarPoint) => number,
  clearance: number,
  surface?: TerrainSurface,
  followGround = false,
  yieldControl?: () => Promise<void>,
): Promise<DecalVertex[][]> {
  if (!surface || !yieldControl) return conformDecalPolygon(outline, plannedHeight, clearance, surface, followGround);
  const rings: DecalVertex[][] = [];
  for (const piece of surface.groundTrianglePieces(outline)) {
    if (!piece) await yieldControl();
    else if (piece.outline.length >= 3) rings.push(conformDecalPiece(piece, plannedHeight, clearance, followGround));
  }
  return rings;
}

function conformDecalPiece(
  piece: TerrainSurfacePiece, plannedHeight: (point: PlanarPoint) => number,
  clearance: number, followGround: boolean,
): DecalVertex[] {
  const ring = signedArea(piece.outline) >= 0 ? piece.outline : [...piece.outline].reverse();
  return ring.map((point) => ({
    x: point.x,
    y: (followGround ? piece.height(point) : Math.max(plannedHeight(point), piece.height(point))) + clearance,
    z: point.z,
  }));
}
