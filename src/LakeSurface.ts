import {
  BaseTexture,
  Mesh,
  TransformNode,
  VertexBuffer,
} from "@babylonjs/core";
import type { TerrainData } from "./TerrainData";
import {
  createWaterSurfaceMaterial,
  prepareWaterSurfaceMesh,
} from "./Water";

export interface LakePoint {
  x: number;
  z: number;
}

export interface LakeSurfaceOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  skyReflection?: BaseTexture | null;
  /** Stable scene offset used to continue wave UVs across terrain tiles. */
  worldOffsetX?: number;
  worldOffsetZ?: number;
}

interface WaterPieceMetadata {
  lakeKey: string;
  observationKey: string;
  elevationMeters: number;
}

interface LakeSurfaceBinding {
  mesh: Mesh;
  baseSurfaceElevationMeters: number;
  metersPerUnit: number;
}

interface LakeLevelState {
  observations: Map<string, number>;
  surfaces: Set<LakeSurfaceBinding>;
  elevationMeters: number;
}

export const LAKE_SURFACE_CLEARANCE_METERS = 0.35;
/** Maximum search distance for mismatches between mapped and raster shorelines. */
const LAKE_MAX_UNDERLAP_METERS = 80;
/** Covers the carved 30 m transition after the last water-classified sample. */
const LAKE_TERRAIN_TRANSITION_MARGIN_METERS = 35;
/** Conservative overlap when land-cover classification is unavailable. */
const LAKE_FALLBACK_UNDERLAP_METERS = 8;
const LAKE_MASK_PROBE_SPACING_METERS = 5;
const LAKE_MASK_INITIAL_GAP_METERS = 35;

const waterPieceMetadata = new WeakMap<Mesh, WaterPieceMetadata>();
const lakeLevels = new Map<string, LakeLevelState>();

/** Expands only where the terrain's own carved-water mask requires coverage. */
export function expandLakeShoreline(
  points: LakePoint[],
  terrain: TerrainData,
  options: LakeSurfaceOptions,
): LakePoint[] {
  const shoreline = resamplePolygon(
    points,
    LAKE_MASK_PROBE_SPACING_METERS / options.metersPerUnit,
  );
  return expandPolygon(shoreline, (point, normal) =>
    lakeUnderlapDistance(point, normal, terrain, options)
  );
}

/** Adds stable UVs, tangents, and cross-tile identity to one staged lake piece. */
export function prepareLakeSurfacePiece(
  mesh: Mesh,
  terrain: TerrainData,
  options: LakeSurfaceOptions,
  lakeKey: string,
  elevationMeters: number,
): void {
  mesh.position.y = (
    elevationMeters + LAKE_SURFACE_CLEARANCE_METERS
  ) / options.metersPerUnit;
  setWaterUvs(
    mesh,
    options.meshWidth,
    options.meshDepth,
    options.worldOffsetX,
    options.worldOffsetZ,
  );
  prepareWaterSurfaceMesh(mesh);
  waterPieceMetadata.set(mesh, {
    lakeKey,
    observationKey: `${terrain.worldTile.level}/${terrain.worldTile.x}/${terrain.worldTile.y}`,
    elevationMeters,
  });
}

/** Levels, merges, and styles every staged lake feature in one terrain tile. */
export function styleLakeSurfaces(
  meshes: Mesh[],
  parent: TransformNode,
  options: LakeSurfaceOptions,
): Mesh[] {
  if (meshes.length === 0) return [];
  const groups = new Map<string, Mesh[]>();
  for (const mesh of meshes) {
    const metadata = waterPieceMetadata.get(mesh);
    const key = metadata?.lakeKey ?? mesh.uniqueId.toString();
    const group = groups.get(key);
    if (group) group.push(mesh);
    else groups.set(key, [mesh]);
  }

  const material = createWaterSurfaceMaterial(parent.getScene(), {
    name: "inlandWaterMaterial",
    width: options.meshWidth,
    height: options.meshDepth,
    metersPerUnit: options.metersPerUnit,
    skyReflection: options.skyReflection,
  });
  const results: Mesh[] = [];
  for (const [lakeKey, pieces] of groups) {
    const metadata = pieces
      .map((piece) => waterPieceMetadata.get(piece))
      .filter((value): value is WaterPieceMetadata => value !== undefined);
    const observationKey = metadata[0]?.observationKey ?? lakeKey;
    const elevation = observeLakeLevel(
      lakeKey,
      observationKey,
      metadata.map((value) => value.elevationMeters),
    );
    const surfaceElevation = elevation + LAKE_SURFACE_CLEARANCE_METERS;
    for (const piece of pieces) {
      piece.position.y = surfaceElevation / options.metersPerUnit;
    }

    const result = pieces.length === 1
      ? pieces[0]
      : Mesh.MergeMeshes(pieces, true, true);
    if (!result) continue;
    if (pieces.length === 1) {
      result.bakeCurrentTransformIntoVertices();
      result.position.setAll(0);
    }
    result.name = `inlandWater-${lakeKey}`;
    result.material = material;
    result.isPickable = false;
    result.parent = parent;
    registerLakeSurface(lakeKey, result, surfaceElevation, options.metersPerUnit);
    results.push(result);
  }
  return results;
}

/**
 * Extends every shoreline edge by its terrain-checked underlap distance.
 * Bevelled corners tolerate concave rings and overlapping provider fragments.
 */
function expandPolygon(
  points: LakePoint[],
  distanceAt: (point: LakePoint, normal: LakePoint) => number,
): LakePoint[] {
  if (points.length < 3) return points;
  const orientation = signedArea(points) >= 0 ? 1 : -1;
  const expanded: LakePoint[] = [];
  for (let index = 0; index < points.length; index++) {
    const previous = points[(index + points.length - 1) % points.length];
    const point = points[index];
    const next = points[(index + 1) % points.length];
    const incoming = outwardNormal(previous, point, orientation);
    const outgoing = outwardNormal(point, next, orientation);
    const incomingDistance = distanceAt(point, incoming);
    const outgoingDistance = distanceAt(point, outgoing);
    const incomingPoint = {
      x: point.x + incoming.x * incomingDistance,
      z: point.z + incoming.z * incomingDistance,
    };
    const outgoingPoint = {
      x: point.x + outgoing.x * outgoingDistance,
      z: point.z + outgoing.z * outgoingDistance,
    };
    expanded.push(incomingPoint);
    if (!samePoint(incomingPoint, outgoingPoint)) expanded.push(outgoingPoint);
  }
  return expanded;
}

function resamplePolygon(points: LakePoint[], maximumSpacing: number): LakePoint[] {
  if (points.length < 2 || maximumSpacing <= 0) return points;
  const sampled: LakePoint[] = [];
  for (let index = 0; index < points.length; index++) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(end.x - start.x, end.z - start.z) / maximumSpacing),
    );
    for (let step = 0; step < steps; step++) {
      const amount = step / steps;
      sampled.push({
        x: start.x + (end.x - start.x) * amount,
        z: start.z + (end.z - start.z) * amount,
      });
    }
  }
  return sampled;
}

function lakeUnderlapDistance(
  point: LakePoint,
  normal: LakePoint,
  terrain: TerrainData,
  options: LakeSurfaceOptions,
): number {
  const fallback = LAKE_FALLBACK_UNDERLAP_METERS / options.metersPerUnit;
  if (!terrain.waterMask) return fallback;

  const maximum = LAKE_MAX_UNDERLAP_METERS / options.metersPerUnit;
  const margin = LAKE_TERRAIN_TRANSITION_MARGIN_METERS / options.metersPerUnit;
  const initialGap = LAKE_MASK_INITIAL_GAP_METERS / options.metersPerUnit;
  const cellSpacing = Math.min(
    options.meshWidth / Math.max(1, terrain.width - 1),
    options.meshDepth / Math.max(1, terrain.height - 1),
  );
  const step = Math.max(1 / options.metersPerUnit, cellSpacing / 2);
  let furthestWater = -Infinity;
  let dryDistance = 0;

  for (let distance = 0; distance <= maximum; distance += step) {
    const water = sampleWaterMask(
      terrain,
      point.x + normal.x * distance,
      point.z + normal.z * distance,
      options.meshWidth,
      options.meshDepth,
    );
    if (water) {
      furthestWater = distance;
      dryDistance = 0;
      continue;
    }
    dryDistance += step;
    if (furthestWater < 0 && distance >= initialGap) break;
    if (furthestWater >= 0 && dryDistance >= margin) break;
  }

  if (furthestWater < 0) return fallback;
  return Math.min(maximum, Math.max(fallback, furthestWater + margin));
}

function sampleWaterMask(
  terrain: TerrainData,
  x: number,
  z: number,
  meshWidth: number,
  meshDepth: number,
): boolean {
  const mask = terrain.waterMask;
  if (!mask) return false;
  const u = x / meshWidth + 0.5;
  const v = 0.5 - z / meshDepth;
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  const column = Math.max(0, Math.min(terrain.width - 1, Math.round(u * (terrain.width - 1))));
  const row = Math.max(0, Math.min(terrain.height - 1, Math.round(v * (terrain.height - 1))));
  return mask[row * terrain.width + column] !== 0;
}

function outwardNormal(start: LakePoint, end: LakePoint, orientation: number): LakePoint {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz) || 1;
  return { x: orientation * dz / length, z: -orientation * dx / length };
}

/** Aligns waves in the stable scene frame instead of restarting on each tile. */
function setWaterUvs(
  mesh: Mesh,
  width: number,
  depth: number,
  worldOffsetX = 0,
  worldOffsetZ = 0,
): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;
  const uvs = new Float32Array((positions.length / 3) * 2);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    uvs[vertex * 2] = (positions[vertex * 3] + worldOffsetX) / width;
    uvs[vertex * 2 + 1] = -(positions[vertex * 3 + 2] + worldOffsetZ) / depth;
  }
  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
}

function observeLakeLevel(
  lakeKey: string,
  observationKey: string,
  elevations: number[],
): number {
  let state = lakeLevels.get(lakeKey);
  if (!state) {
    state = { observations: new Map(), surfaces: new Set(), elevationMeters: elevations[0] };
    lakeLevels.set(lakeKey, state);
  }
  if (elevations.length > 0) {
    state.observations.set(observationKey, quantile(elevations, 0.25));
    state.elevationMeters = quantile([...state.observations.values()], 0.25);
  }
  for (const surface of state.surfaces) {
    surface.mesh.position.y = (
      state.elevationMeters + LAKE_SURFACE_CLEARANCE_METERS -
      surface.baseSurfaceElevationMeters
    ) / surface.metersPerUnit;
  }
  return state.elevationMeters;
}

function registerLakeSurface(
  lakeKey: string,
  mesh: Mesh,
  baseSurfaceElevationMeters: number,
  metersPerUnit: number,
): void {
  const state = lakeLevels.get(lakeKey);
  if (!state) return;
  const binding = { mesh, baseSurfaceElevationMeters, metersPerUnit };
  state.surfaces.add(binding);
  mesh.onDisposeObservable.addOnce(() => state.surfaces.delete(binding));
}

function signedArea(points: LakePoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.z - next.x * points[index].z;
  }
  return area / 2;
}

function samePoint(a: LakePoint, b: LakePoint): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
}

function quantile(values: number[], amount: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * amount));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const blend = position - lower;
  return sorted[lower] * (1 - blend) + sorted[upper] * blend;
}
