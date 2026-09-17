import { Mesh, VertexBuffer } from "@babylonjs/core";

/**
 * Extrudes the upward faces of a mesh into snow slabs with side walls. Used
 * for building roofs, where a flat surface wants one continuous layer whose
 * thickness shows at the eaves. Irregular actors use SnowFall instead.
 */
export interface SnowShellOptions {
  /** Slab thickness in mesh units. */
  thickness: number;
  /** Only faces passing this test grow a slab; receives a vertex of the face. */
  capFilter?: (vertexIndex: number) => boolean;
  /** Surface id written to uv2.x on slab vertices, for the building shader. */
  surfaceId?: number;
}

/** Faces at least this upward-facing collect snow; steeper ones shed it. */
const CAP_UP_THRESHOLD = 0.45;
const SNOW_RGB = [0.9, 0.94, 0.98] as const;

function hash3(x: number, y: number, z: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return value - Math.floor(value);
}

/** Appends the slabs in place. Returns how many faces grew one. */
export function appendSnowShell(mesh: Mesh, options: SnowShellOptions): number {
  if (!(options.thickness > 0)) return 0;
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const indices = mesh.getIndices();
  if (!positions || !indices || indices.length === 0) return 0;
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  const kinds = mesh.getVerticesDataKinds().map((kind) => ({
    kind, size: mesh.getVertexBuffer(kind)!.getSize(), data: mesh.getVerticesData(kind)!, extra: [] as number[],
  }));
  let vertexCount = positions.length / 3;

  const cloneVertex = (source: number, dy: number, normal: readonly [number, number, number]): number => {
    const index = vertexCount++;
    for (const entry of kinds) {
      const base = source * entry.size;
      const out = entry.extra;
      if (entry.kind === VertexBuffer.PositionKind) {
        out.push(entry.data[base], entry.data[base + 1] + dy, entry.data[base + 2]);
      } else if (entry.kind === VertexBuffer.NormalKind) {
        out.push(normal[0], normal[1], normal[2]);
      } else if (entry.kind === VertexBuffer.ColorKind) {
        const shade = 0.94 + 0.08 * hash3(entry.data[base] + source, dy, source * 0.37);
        out.push(SNOW_RGB[0] * shade, SNOW_RGB[1] * shade, SNOW_RGB[2] * shade);
        if (entry.size === 4) out.push(1);
      } else if (entry.kind === VertexBuffer.UV2Kind && options.surfaceId !== undefined) {
        out.push(options.surfaceId);
        for (let component = 1; component < entry.size; component++) out.push(entry.data[base + component]);
      } else {
        for (let component = 0; component < entry.size; component++) out.push(entry.data[base + component]);
      }
    }
    return index;
  };
  const lump = (vertex: number): number => options.thickness * (
    0.75 + 0.5 * hash3(positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2])
  );
  const up: readonly [number, number, number] = [0, 1, 0];
  const vertexNormal = (vertex: number) => (
    normals ? [normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2]] as const : up
  );

  const newIndices: number[] = [];
  const tops = new Map<number, number>();
  const boundary = new Map<string, { a: number; b: number; cx: number; cz: number }>();
  let capFaces = 0;
  for (let face = 0; face < indices.length; face += 3) {
    const i0 = indices[face], i1 = indices[face + 1], i2 = indices[face + 2];
    const ax = positions[i1 * 3] - positions[i0 * 3], ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1], az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
    const bx = positions[i2 * 3] - positions[i0 * 3], by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1], bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];
    const ny = az * bx - ax * bz;
    const length = Math.hypot(ay * bz - az * by, ny, ax * by - ay * bx);
    if (length < 1e-12) continue;
    let upness = ny / length;
    if (normals && upness * normals[i0 * 3 + 1] < 0) upness = -upness;
    if (upness <= CAP_UP_THRESHOLD || (options.capFilter && !options.capFilter(i0))) continue;
    const cx = (positions[i0 * 3] + positions[i1 * 3] + positions[i2 * 3]) / 3;
    const cz = (positions[i0 * 3 + 2] + positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 3;
    const top = [i0, i1, i2].map((vertex) => {
      let index = tops.get(vertex);
      if (index === undefined) { index = cloneVertex(vertex, lump(vertex), vertexNormal(vertex)); tops.set(vertex, index); }
      return index;
    });
    newIndices.push(top[0], top[1], top[2]);
    // Edges seen once bound the slab and get a side wall.
    for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]] as const) {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (boundary.has(key)) boundary.delete(key); else boundary.set(key, { a, b, cx, cz });
    }
    capFaces++;
  }
  if (capFaces === 0) return 0;

  for (const edge of boundary.values()) {
    const ax = positions[edge.a * 3], az = positions[edge.a * 3 + 2];
    const bx = positions[edge.b * 3], bz = positions[edge.b * 3 + 2];
    let sx = bz - az, sz = -(bx - ax);
    const sideLength = Math.hypot(sx, sz);
    if (sideLength < 1e-9) continue;
    sx /= sideLength; sz /= sideLength;
    if (((ax + bx) / 2 - edge.cx) * sx + ((az + bz) / 2 - edge.cz) * sz < 0) { sx = -sx; sz = -sz; }
    const side: readonly [number, number, number] = [sx, 0, sz];
    const baseA = cloneVertex(edge.a, 0, side), baseB = cloneVertex(edge.b, 0, side);
    const topA = cloneVertex(edge.a, lump(edge.a), side), topB = cloneVertex(edge.b, lump(edge.b), side);
    if ((bz - az) * sx - (bx - ax) * sz < 0) newIndices.push(baseA, baseB, topB, baseA, topB, topA);
    else newIndices.push(baseA, topB, baseB, baseA, topA, topB);
  }

  for (const entry of kinds) {
    const merged = new Float32Array(entry.data.length + entry.extra.length);
    merged.set(entry.data);
    merged.set(entry.extra, entry.data.length);
    mesh.setVerticesData(entry.kind, merged, false, entry.size);
  }
  const mergedIndices = new Uint32Array(indices.length + newIndices.length);
  mergedIndices.set(indices);
  mergedIndices.set(newIndices, indices.length);
  mesh.setIndices(mergedIndices, vertexCount);
  mesh.refreshBoundingInfo();
  return capFaces;
}
