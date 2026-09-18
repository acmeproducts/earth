import { appendMeshBuffers } from "./CompactMeshBuffers";
import { spatialHash3 as hash } from "../core/Random";
import { Mesh, VertexBuffer } from "@babylonjs/core";

/**
 * Snowfall simulation for procedural actors. Instead of deriving snow from the
 * mesh faces, snow is dropped straight down over the actor on a grid of rays.
 * Whatever a ray meets first catches most of it: a solid top face keeps all,
 * a foliage cluster keeps some and lets the rest sift through to the branches
 * and clusters below. The catches accumulate per grid cell and height layer
 * and become a blanket: one small mound per cell, joined to its neighbours
 * where they lie at the same height, drooping at open edges. Only what the
 * sky can see turns white, which is how a tree or a stone actually loads up.
 */
export interface SnowfallOptions {
  /** Grid cell size in mesh units; one blanket mound per cell and layer. */
  cellSize: number;
  /** Blanket thickness in mesh units where a cell caught all of its snow. */
  depth: number;
  /** Snow depth in [0, 1]; light falls only whiten the best-exposed spots. */
  amount: number;
  /** Fraction of the snow that sifts through a foliage cluster. Defaults to 0.45. */
  foliageTransmittance?: number;
  /** Whether a face is a foliage cluster, from its first vertex's uv.x. */
  isFoliage?: (uvX: number) => boolean;
  /** Rays dropped per cell. Defaults to 4. */
  raysPerCell?: number;
}

/**
 * Blanket vertices carry uv.x = -2. The vegetation shader reads it as "no
 * texture, no land-cover tint": the snow color sits in the vertex colors.
 */
export const SNOW_UV_X = -2;

export interface SnowfallResult {
  /** Blanket mounds generated. */
  mounds: number;
  /** Rays that met nothing. */
  missed: number;
}

interface VertexKind {
  kind: string;
  size: number;
  data: Float32Array | number[];
  extra: number[];
}

interface TopFace {
  a: number; b: number; c: number;
  ax: number; az: number; bx: number; bz: number; cx: number; cz: number;
  ay: number; by: number; cy: number;
  det: number;
}

interface Catcher {
  vertex: number;
  x: number;
  z: number;
  radiusSquared: number;
  topY: number;
}

interface Layer {
  y: number;
  deposit: number;
  vertex: number;
}

interface Deposit {
  cellX: number;
  cellZ: number;
  y: number;
  deposit: number;
  vertex: number;
  component: number;
}

const SNOW_RGB = [0.9, 0.94, 0.98] as const;
const MAX_CELLS_PER_AXIS = 96;

/** Drops snow on a mesh and appends the resulting blanket geometry in place. */
export function simulateSnowfall(mesh: Mesh, options: SnowfallOptions): SnowfallResult {
  const none = { mounds: 0, missed: 0 };
  if (!(options.depth > 0) || !(options.cellSize > 0)) return none;
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const indices = mesh.getIndices();
  if (!positions || !indices || indices.length === 0) return none;
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
  const colors = mesh.getVerticesData(VertexBuffer.ColorKind);
  // Foliage classification is opt-in: only vegetation follows the uv.x
  // convention, and a textured stone or box must stay a solid catcher.
  const isFoliage = options.isFoliage;
  const transmittance = options.foliageTransmittance ?? 0.45;
  const raysPerCell = Math.max(1, Math.round(options.raysPerCell ?? 4));
  const amount = Math.max(0, Math.min(1, options.amount));

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let index = 0; index < positions.length; index += 3) {
    minX = Math.min(minX, positions[index]);
    maxX = Math.max(maxX, positions[index]);
    minZ = Math.min(minZ, positions[index + 2]);
    maxZ = Math.max(maxZ, positions[index + 2]);
  }
  const cellSize = Math.max(
    options.cellSize,
    (maxX - minX) / MAX_CELLS_PER_AXIS,
    (maxZ - minZ) / MAX_CELLS_PER_AXIS,
  );
  const cellsX = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const cellsZ = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
  const cellIndex = (x: number, z: number) => x + z * cellsX;
  const cellOf = (x: number, z: number): [number, number] => [
    Math.min(cellsX - 1, Math.max(0, Math.floor((x - minX) / cellSize))),
    Math.min(cellsZ - 1, Math.max(0, Math.floor((z - minZ) / cellSize))),
  ];

  // Bin what the falling snow can land on: sky-facing solid faces exactly,
  // foliage clusters as discs around their centre, since a cluster's cards
  // stand in arbitrary planes and would otherwise present no area from above.
  const topFaces: TopFace[][] = Array.from({ length: cellsX * cellsZ }, () => []);
  const catchers: Catcher[][] = Array.from({ length: cellsX * cellsZ }, () => []);
  for (let face = 0; face < indices.length; face += 3) {
    const a = indices[face], b = indices[face + 1], c = indices[face + 2];
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    const foliage = isFoliage !== undefined && (uvs
      ? isFoliage(uvs[a * 2])
      : Boolean(colors) && colors![a * 4 + 1] > colors![a * 4] * 1.1);
    if (foliage) {
      const centerX = (ax + bx + cx) / 3;
      const centerZ = (az + bz + cz) / 3;
      const radius = Math.max(
        cellSize * 0.45,
        0.5 * Math.max(Math.max(ax, bx, cx) - Math.min(ax, bx, cx), Math.max(az, bz, cz) - Math.min(az, bz, cz)),
      );
      // Snow settles into the upper part of a cluster, not on the tip of its
      // tallest card, so the blanket sits within the foliage.
      const catcher: Catcher = {
        vertex: a, x: centerX, z: centerZ, radiusSquared: radius * radius,
        topY: Math.max(ay, by, cy) * 0.6 + Math.min(ay, by, cy) * 0.4,
      };
      const [x0, z0] = cellOf(centerX - radius, centerZ - radius);
      const [x1, z1] = cellOf(centerX + radius, centerZ + radius);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) catchers[cellIndex(x, z)].push(catcher);
      continue;
    }
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-12) continue;
    let upness = ny / length;
    if (normals && upness * normals[a * 3 + 1] < 0) upness = -upness;
    if (upness < 0.25) continue;
    const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(det) < 1e-12) continue;
    const top: TopFace = { a, b, c, ax, az, bx, bz, cx, cz, ay, by, cy, det };
    const [x0, z0] = cellOf(Math.min(ax, bx, cx), Math.min(az, bz, cz));
    const [x1, z1] = cellOf(Math.max(ax, bx, cx), Math.max(az, bz, cz));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) topFaces[cellIndex(x, z)].push(top);
  }

  // Drop the rays. Each ray hands its snow down through the hits it meets.
  const layerTolerance = cellSize * 1.5;
  const layers: Layer[][] = Array.from({ length: cellsX * cellsZ }, () => []);
  const hits: { y: number; vertex: number; solid: boolean }[] = [];
  let missed = 0;
  for (let cellZ = 0; cellZ < cellsZ; cellZ++) {
    for (let cellX = 0; cellX < cellsX; cellX++) {
      const cell = cellIndex(cellX, cellZ);
      const cellLayers = layers[cell];
      for (let ray = 0; ray < raysPerCell; ray++) {
        const px = minX + (cellX + hash(cellX, cellZ, ray * 2 + 1)) * cellSize;
        const pz = minZ + (cellZ + hash(cellX, cellZ, ray * 2 + 2)) * cellSize;
        hits.length = 0;
        for (const top of topFaces[cell]) {
          const u = ((px - top.ax) * (top.cz - top.az) - (top.cx - top.ax) * (pz - top.az)) / top.det;
          const v = ((top.bx - top.ax) * (pz - top.az) - (px - top.ax) * (top.bz - top.az)) / top.det;
          if (u < 0 || v < 0 || u + v > 1) continue;
          hits.push({ y: top.ay + u * (top.by - top.ay) + v * (top.cy - top.ay), vertex: top.a, solid: true });
        }
        for (const catcher of catchers[cell]) {
          const dx = px - catcher.x;
          const dz = pz - catcher.z;
          if (dx * dx + dz * dz > catcher.radiusSquared) continue;
          hits.push({ y: catcher.topY, vertex: catcher.vertex, solid: false });
        }
        if (hits.length === 0) { missed++; continue; }
        hits.sort((left, right) => right.y - left.y);
        let budget = 1;
        for (const hit of hits) {
          const caught = hit.solid ? budget : budget * (1 - transmittance);
          let layer = cellLayers.find((candidate) => Math.abs(candidate.y - hit.y) < layerTolerance);
          if (!layer) {
            layer = { y: hit.y, deposit: 0, vertex: hit.vertex };
            cellLayers.push(layer);
          }
          layer.y = (layer.y * layer.deposit + hit.y * caught) / (layer.deposit + caught);
          layer.deposit += caught;
          budget = hit.solid ? 0 : budget * transmittance;
          if (budget < 0.05) break;
        }
      }
    }
  }

  // Keep the cells that caught enough; a light fall only whitens exposed tops.
  const threshold = 0.28 + 0.35 * (1 - amount);
  const deposits: Deposit[] = [];
  for (let cellZ = 0; cellZ < cellsZ; cellZ++) {
    for (let cellX = 0; cellX < cellsX; cellX++) {
      for (const layer of layers[cellIndex(cellX, cellZ)]) {
        const deposit = Math.min(1, layer.deposit / raysPerCell);
        if (deposit < threshold) continue;
        deposits.push({ cellX, cellZ, y: layer.y, deposit, vertex: layer.vertex, component: deposits.length });
      }
    }
  }
  if (deposits.length === 0) return { mounds: 0, missed };

  // Join neighbouring mounds at the same height into one blanket.
  const byCell = new Map<number, Deposit[]>();
  for (const deposit of deposits) {
    const key = cellIndex(deposit.cellX, deposit.cellZ);
    const list = byCell.get(key);
    if (list) list.push(deposit); else byCell.set(key, [deposit]);
  }
  const parent = deposits.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  for (const deposit of deposits) {
    for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
      const neighbourX = deposit.cellX + dx;
      const neighbourZ = deposit.cellZ + dz;
      if (neighbourX >= cellsX || neighbourZ >= cellsZ) continue;
      for (const other of byCell.get(cellIndex(neighbourX, neighbourZ)) ?? []) {
        if (Math.abs(other.y - deposit.y) < layerTolerance) parent[find(other.component)] = find(deposit.component);
      }
    }
  }

  // Corner heights are shared within a blanket; a corner few mounds reach is
  // an edge and droops so the layer shows its thickness.
  const corners = new Map<string, { sumY: number; count: number; vertex: number; index: number }>();
  const cornerKey = (component: number, x: number, z: number) => `${component}:${x}:${z}`;
  for (const deposit of deposits) {
    const component = find(deposit.component);
    const surfaceY = deposit.y + options.depth * deposit.deposit * 0.6;
    for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const key = cornerKey(component, deposit.cellX + dx, deposit.cellZ + dz);
      const corner = corners.get(key);
      if (corner) { corner.sumY += surfaceY; corner.count++; } else corners.set(key, { sumY: surfaceY, count: 1, vertex: deposit.vertex, index: -1 });
    }
  }

  // Emit geometry, copying every other vertex attribute from the surface the
  // snow landed on so baked lighting data stays consistent.
  const kinds: VertexKind[] = mesh.getVerticesDataKinds().map((kind) => ({
    kind, size: mesh.getVertexBuffer(kind)!.getSize(), data: mesh.getVerticesData(kind)!, extra: [],
  }));
  const sourceVertexCount = positions.length / 3;
  let vertexCount = sourceVertexCount;
  const newPositions: number[] = [];
  const emitVertex = (source: number, x: number, y: number, z: number): number => {
    const index = vertexCount++;
    newPositions.push(x, y, z);
    for (const entry of kinds) {
      const out = entry.extra;
      const base = source * entry.size;
      if (entry.kind === VertexBuffer.PositionKind) out.push(x, y, z);
      else if (entry.kind === VertexBuffer.NormalKind) out.push(0, 1, 0);
      else if (entry.kind === VertexBuffer.UVKind) { out.push(SNOW_UV_X, 0); for (let component = 2; component < entry.size; component++) out.push(0); }
      else if (entry.kind === VertexBuffer.ColorKind) {
        const shade = 0.94 + 0.08 * hash(x, y, z);
        out.push(SNOW_RGB[0] * shade, SNOW_RGB[1] * shade, SNOW_RGB[2] * shade);
        if (entry.size === 4) out.push(1);
      } else for (let component = 0; component < entry.size; component++) out.push(entry.data[base + component]);
    }
    return index;
  };
  const newIndices: number[] = [];
  for (const deposit of deposits) {
    const component = find(deposit.component);
    const cornerIndices = ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).map(([dx, dz]) => {
      const key = cornerKey(component, deposit.cellX + dx, deposit.cellZ + dz);
      const corner = corners.get(key)!;
      if (corner.index < 0) {
        const cornerX = minX + (deposit.cellX + dx) * cellSize;
        const cornerZ = minZ + (deposit.cellZ + dz) * cellSize;
        // Open edges curl down to show the layer's thickness; shared corners
        // wander a little so a blanket reads as drifted snow, not a plate.
        const droop = options.depth * 0.7 * (1 - corner.count / 4);
        const jitter = options.depth * 0.3 * (hash(cornerX, cornerZ, corner.sumY) - 0.5);
        corner.index = emitVertex(corner.vertex, cornerX, corner.sumY / corner.count - droop + jitter, cornerZ);
      }
      return corner.index;
    });
    const center = emitVertex(
      deposit.vertex,
      minX + (deposit.cellX + 0.5) * cellSize,
      deposit.y + options.depth * deposit.deposit,
      minZ + (deposit.cellZ + 0.5) * cellSize,
    );
    for (let corner = 0; corner < 4; corner++) {
      newIndices.push(center, cornerIndices[corner], cornerIndices[(corner + 1) % 4]);
    }
  }

  // Smooth normals for the new mounds from their own faces.
  const normalKind = kinds.find((entry) => entry.kind === VertexBuffer.NormalKind);
  if (normalKind) {
    const accumulated = new Float32Array(newPositions.length);
    for (let face = 0; face < newIndices.length; face += 3) {
      const a = (newIndices[face] - sourceVertexCount) * 3;
      const b = (newIndices[face + 1] - sourceVertexCount) * 3;
      const c = (newIndices[face + 2] - sourceVertexCount) * 3;
      const ux = newPositions[b] - newPositions[a], uy = newPositions[b + 1] - newPositions[a + 1], uz = newPositions[b + 2] - newPositions[a + 2];
      const vx = newPositions[c] - newPositions[a], vy = newPositions[c + 1] - newPositions[a + 1], vz = newPositions[c + 2] - newPositions[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      for (const offset of [a, b, c]) { accumulated[offset] += nx; accumulated[offset + 1] += ny; accumulated[offset + 2] += nz; }
    }
    for (let vertex = 0; vertex < accumulated.length; vertex += 3) {
      const length = Math.hypot(accumulated[vertex], accumulated[vertex + 1], accumulated[vertex + 2]) || 1;
      normalKind.extra[vertex] = accumulated[vertex] / length;
      normalKind.extra[vertex + 1] = accumulated[vertex + 1] / length;
      normalKind.extra[vertex + 2] = accumulated[vertex + 2] / length;
    }
  }

  appendMeshBuffers(mesh, kinds, indices, newIndices, vertexCount);
  return { mounds: deposits.length, missed };
}

/**
 * Lets snow fall on vegetation models or capture sources. Mound size and
 * depth are fractions of the model height so a live model and its atlas agree.
 */
export function applyVegetationSnowfall(meshes: readonly Mesh[], modelHeight: number, snowCover: number): void {
  if (!(snowCover > 0)) return;
  for (const mesh of meshes) {
    simulateSnowfall(mesh, {
      cellSize: 0.035 * modelHeight,
      depth: 0.024 * modelHeight * (0.4 + 0.6 * snowCover),
      amount: snowCover,
      // The vegetation shader's uv convention: cards below 1.5, bark from 2.
      isFoliage: (uvX) => uvX >= -0.5 && uvX < 1.5,
    });
  }
}
