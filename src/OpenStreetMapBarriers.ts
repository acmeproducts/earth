import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import {
  HorizontalExclusionMask,
  lonLatToScene,
  sampleElevation,
} from "./Geo";
import type { TerrainData } from "./TerrainData";
import type { TileBounds } from "./WorldGrid";

export type BarrierType =
  | "hedge"
  | "fence"
  | "wall"
  | "guard_rail"
  | "jersey_barrier"
  | "cable_barrier"
  | "retaining_wall";

export interface BarrierFeature {
  id: number;
  type: BarrierType;
  coordinates: Array<readonly [number, number]>;
  tags: Readonly<Record<string, string>>;
}

export interface BarrierLayerOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  startDisabled?: boolean;
}

export interface BarrierFeatureLayer {
  root: TransformNode;
  meshes: Mesh[];
  count: number;
}

interface OverpassResponse {
  elements?: unknown[];
}

interface BarrierAppearance {
  style: "hedge" | "fence" | "guardRail" | "wall" | "noiseBarrier" | "jerseyBarrier";
  heightMeters: number;
}

interface HorizontalSegment {
  start: { x: number; z: number };
  end: { x: number; z: number };
  halfWidth: number;
}

/** OSM line-detail omitted by the general-purpose OpenMapTiles schema. */
export class OpenStreetMapBarriers {
  private static readonly QUERY_ZOOM = 14;
  private static readonly DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";
  private static readonly cache = new Map<string, Promise<BarrierFeature[]>>();

  /**
   * Loads the zoom-14 parent of an application tile. Four level-16 terrain
   * tiles therefore share one compact request and one cached response.
   */
  static fetch(bounds: TileBounds): Promise<BarrierFeature[]> {
    const tile = tileFor(bounds.lonWest + 1e-10, bounds.latNorth - 1e-10, this.QUERY_ZOOM);
    const key = `${this.QUERY_ZOOM}/${tile.x}/${tile.y}`;
    let request = this.cache.get(key);
    if (!request) {
      const queryBounds = tileBounds(tile.x, tile.y, this.QUERY_ZOOM);
      request = this.fetchRegion(queryBounds).catch((error: unknown) => {
        // Barriers are optional scene detail. Retain an empty cached result so
        // one unavailable public endpoint cannot trigger a retry storm as the
        // four child terrain tiles finish loading.
        console.warn(`OpenStreetMap barriers unavailable for ${key}; the layer was skipped.`, error);
        return [];
      });
      this.cache.set(key, request);
    }
    return request;
  }

  static async createLayer(
    scene: Scene,
    features: readonly BarrierFeature[],
    terrain: TerrainData,
    options: BarrierLayerOptions,
    yieldControl?: () => Promise<void>,
  ): Promise<BarrierFeatureLayer> {
    const root = new TransformNode("barriers", scene);
    if (options.startDisabled) root.setEnabled(false);
    const byStyle = new Map<BarrierAppearance["style"], Mesh[]>();
    let count = 0;

    for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
      const feature = features[featureIndex];
      const appearance = barrierAppearance(feature);
      const projected = feature.coordinates.map(([lon, lat]) =>
        lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth),
      );
      const clipped = clipPolyline(projected, options.meshWidth / 2, options.meshDepth / 2);
      let rendered = false;
      for (const path of clipped) {
        const sampled = resamplePath(path, 2 / options.metersPerUnit);
        const mesh = appearance.style === "hedge"
          ? createHedge(scene, sampled, terrain, options, appearance.heightMeters)
          : createBarrierRibbon(scene, sampled, terrain, options, appearance.heightMeters, appearance.style);
        if (!mesh) continue;
        const meshes = byStyle.get(appearance.style);
        if (meshes) meshes.push(mesh);
        else byStyle.set(appearance.style, [mesh]);
        rendered = true;
      }
      if (rendered) count++;
      if ((featureIndex + 1) % 24 === 0) await yieldControl?.();
    }

    const meshes: Mesh[] = [];
    for (const [style, sources] of byStyle) {
      const merged = sources.length === 1 ? sources[0] : Mesh.MergeMeshes(sources, true, true);
      if (!merged) continue;
      merged.name = `${style}Barriers`;
      merged.material = createBarrierMaterial(scene, style);
      merged.isPickable = false;
      merged.parent = root;
      merged.setEnabled(true);
      meshes.push(merged);
    }
    return { root, meshes, count };
  }

  /** Prevents procedurally placed trees and shrubs from crossing solid mapped barriers. */
  static createExclusionMask(
    features: readonly BarrierFeature[],
    terrain: TerrainData,
    options: Pick<BarrierLayerOptions, "meshWidth" | "meshDepth" | "metersPerUnit">,
  ): HorizontalExclusionMask {
    const segments: HorizontalSegment[] = [];
    for (const feature of features) {
      const projected = feature.coordinates.map(([lon, lat]) =>
        lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth),
      );
      const clearanceMeters = feature.type === "hedge" ? 0.9 : 0.35;
      for (const path of clipPolyline(projected, options.meshWidth / 2, options.meshDepth / 2)) {
        for (let index = 1; index < path.length; index++) {
          segments.push({
            start: path[index - 1],
            end: path[index],
            halfWidth: clearanceMeters / options.metersPerUnit,
          });
        }
      }
    }
    return new SegmentExclusionMask(segments, 12 / options.metersPerUnit);
  }

  private static async fetchRegion(bounds: TileBounds): Promise<BarrierFeature[]> {
    const endpoint = typeof document === "undefined"
      ? this.DEFAULT_ENDPOINT
      : document.querySelector<HTMLMetaElement>('meta[name="overpass-url"]')?.content ||
        this.DEFAULT_ENDPOINT;
    const bbox = [bounds.latSouth, bounds.lonWest, bounds.latNorth, bounds.lonEast].join(",");
    const query = `[out:json][timeout:15];way["barrier"~"^(hedge|fence|wall|guard_rail|jersey_barrier|cable_barrier|retaining_wall)$"](${bbox});out tags geom qt;`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({ data: query }),
    });
    if (!response.ok) throw new Error(`Overpass request failed (${response.status}).`);
    const payload = await response.json() as OverpassResponse;
    return parseBarrierFeatures(payload.elements);
  }
}

function parseBarrierFeatures(elements: unknown): BarrierFeature[] {
  if (!Array.isArray(elements)) return [];
  const features: BarrierFeature[] = [];
  for (const value of elements) {
    if (!value || typeof value !== "object") continue;
    const element = value as Record<string, unknown>;
    if (element.type !== "way" || !Number.isFinite(element.id)) continue;
    if (!element.tags || typeof element.tags !== "object") continue;
    const rawTags = element.tags as Record<string, unknown>;
    const type = rawTags.barrier;
    if (!isBarrierType(type) || !Array.isArray(element.geometry)) continue;
    const coordinates: Array<readonly [number, number]> = [];
    for (const point of element.geometry) {
      if (!point || typeof point !== "object") continue;
      const { lon, lat } = point as { lon?: unknown; lat?: unknown };
      if (typeof lon === "number" && Number.isFinite(lon) &&
          typeof lat === "number" && Number.isFinite(lat)) {
        coordinates.push([lon, lat]);
      }
    }
    if (coordinates.length < 2) continue;
    const tags: Record<string, string> = {};
    for (const [key, tagValue] of Object.entries(rawTags)) {
      if (typeof tagValue === "string") tags[key] = tagValue;
    }
    features.push({ id: element.id as number, type, coordinates, tags });
  }
  return features;
}

function isBarrierType(value: unknown): value is BarrierType {
  return value === "hedge" || value === "fence" || value === "wall" ||
    value === "guard_rail" || value === "jersey_barrier" ||
    value === "cable_barrier" || value === "retaining_wall";
}

function barrierAppearance(feature: BarrierFeature): BarrierAppearance {
  const taggedHeight = positiveMeters(feature.tags.height);
  switch (feature.type) {
    case "hedge": return { style: "hedge", heightMeters: taggedHeight ?? 1.6 };
    case "fence": return { style: "fence", heightMeters: taggedHeight ?? 1.5 };
    case "guard_rail": return { style: "guardRail", heightMeters: taggedHeight ?? 0.78 };
    case "cable_barrier": return { style: "fence", heightMeters: taggedHeight ?? 0.85 };
    case "jersey_barrier": return { style: "jerseyBarrier", heightMeters: taggedHeight ?? 0.82 };
    case "retaining_wall": return { style: "wall", heightMeters: taggedHeight ?? 1.5 };
    case "wall": return {
      style: feature.tags.wall === "noise_barrier" ? "noiseBarrier" : "wall",
      heightMeters: taggedHeight ?? (feature.tags.wall === "noise_barrier" ? 3 : 1.8),
    };
  }
}

function positiveMeters(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 12) : undefined;
}

function createHedge(
  scene: Scene,
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: BarrierLayerOptions,
  heightMeters: number,
): Mesh | undefined {
  if (points.length < 2) return undefined;
  const radius = Math.max(0.3, Math.min(1.1, heightMeters / 2)) / options.metersPerUnit;
  const path = points.map((point) => new Vector3(
    point.x,
    sampleElevation(terrain, point.x, point.z, options.meshWidth, options.meshDepth) /
      options.metersPerUnit + radius,
    point.z,
  ));
  const mesh = MeshBuilder.CreateTube("hedge", {
    path,
    radius,
    tessellation: 5,
    cap: Mesh.CAP_ALL,
  }, scene);
  mesh.setEnabled(false);
  return mesh;
}

function createBarrierRibbon(
  scene: Scene,
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: BarrierLayerOptions,
  heightMeters: number,
  style: BarrierAppearance["style"],
): Mesh | undefined {
  if (points.length < 2) return undefined;
  const groundClearance = style === "guardRail" ? 0.42 : 0.025;
  const visibleHeight = style === "guardRail" ? 0.34 : heightMeters;
  const bottom: Vector3[] = [];
  const top: Vector3[] = [];
  for (const point of points) {
    const ground = sampleElevation(
      terrain,
      point.x,
      point.z,
      options.meshWidth,
      options.meshDepth,
    );
    bottom.push(new Vector3(
      point.x,
      (ground + groundClearance) / options.metersPerUnit,
      point.z,
    ));
    top.push(new Vector3(
      point.x,
      (ground + groundClearance + visibleHeight) / options.metersPerUnit,
      point.z,
    ));
  }
  const mesh = MeshBuilder.CreateRibbon("barrier", { pathArray: [bottom, top] }, scene);
  mesh.setEnabled(false);
  return mesh;
}

function createBarrierMaterial(scene: Scene, style: BarrierAppearance["style"]): StandardMaterial {
  const material = new StandardMaterial(`${style}BarrierMaterial`, scene);
  material.backFaceCulling = false;
  material.specularColor = new Color3(0.03, 0.03, 0.03);
  switch (style) {
    case "hedge":
      material.diffuseColor = new Color3(0.12, 0.27, 0.075);
      break;
    case "fence":
      material.diffuseColor = new Color3(0.24, 0.25, 0.23);
      material.wireframe = true;
      break;
    case "guardRail":
      material.diffuseColor = new Color3(0.48, 0.5, 0.49);
      material.specularColor = new Color3(0.28, 0.29, 0.28);
      break;
    case "noiseBarrier":
      material.diffuseColor = new Color3(0.38, 0.42, 0.35);
      break;
    case "jerseyBarrier":
      material.diffuseColor = new Color3(0.49, 0.48, 0.45);
      break;
    case "wall":
      material.diffuseColor = new Color3(0.37, 0.35, 0.31);
      break;
  }
  return material;
}

class SegmentExclusionMask implements HorizontalExclusionMask {
  private readonly cells = new Map<string, HorizontalSegment[]>();

  constructor(segments: readonly HorizontalSegment[], private readonly cellSize: number) {
    for (const segment of segments) {
      const minimumX = Math.floor((Math.min(segment.start.x, segment.end.x) - segment.halfWidth) / cellSize);
      const maximumX = Math.floor((Math.max(segment.start.x, segment.end.x) + segment.halfWidth) / cellSize);
      const minimumZ = Math.floor((Math.min(segment.start.z, segment.end.z) - segment.halfWidth) / cellSize);
      const maximumZ = Math.floor((Math.max(segment.start.z, segment.end.z) + segment.halfWidth) / cellSize);
      for (let z = minimumZ; z <= maximumZ; z++) {
        for (let x = minimumX; x <= maximumX; x++) {
          const key = `${x},${z}`;
          const cell = this.cells.get(key);
          if (cell) cell.push(segment);
          else this.cells.set(key, [segment]);
        }
      }
    }
  }

  intersects(x: number, z: number, radius: number): boolean {
    const minimumX = Math.floor((x - radius) / this.cellSize);
    const maximumX = Math.floor((x + radius) / this.cellSize);
    const minimumZ = Math.floor((z - radius) / this.cellSize);
    const maximumZ = Math.floor((z + radius) / this.cellSize);
    for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ++) {
      for (let cellX = minimumX; cellX <= maximumX; cellX++) {
        for (const segment of this.cells.get(`${cellX},${cellZ}`) ?? []) {
          const clearance = radius + segment.halfWidth;
          if (pointSegmentDistanceSquared(x, z, segment.start, segment.end) <= clearance * clearance) {
            return true;
          }
        }
      }
    }
    return false;
  }
}

function pointSegmentDistanceSquared(
  x: number,
  z: number,
  start: { x: number; z: number },
  end: { x: number; z: number },
): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((x - start.x) * dx + (z - start.z) * dz) / lengthSquared));
  const offsetX = x - (start.x + dx * amount);
  const offsetZ = z - (start.z + dz * amount);
  return offsetX * offsetX + offsetZ * offsetZ;
}

function resamplePath(
  points: Array<{ x: number; z: number }>,
  maximumSpacing: number,
): Array<{ x: number; z: number }> {
  if (points.length < 2 || maximumSpacing <= 0) return points;
  const sampled = [points[0]];
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const steps = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.z - start.z) / maximumSpacing));
    for (let step = 1; step <= steps; step++) {
      const amount = step / steps;
      sampled.push({
        x: start.x + (end.x - start.x) * amount,
        z: start.z + (end.z - start.z) * amount,
      });
    }
  }
  return sampled;
}

function clipPolyline(
  points: Array<{ x: number; z: number }>,
  halfWidth: number,
  halfDepth: number,
): Array<Array<{ x: number; z: number }>> {
  const paths: Array<Array<{ x: number; z: number }>> = [];
  let current: Array<{ x: number; z: number }> | undefined;
  for (let index = 1; index < points.length; index++) {
    const segment = clipSegment(points[index - 1], points[index], halfWidth, halfDepth);
    if (!segment) {
      current = undefined;
      continue;
    }
    if (!current || !samePoint(current[current.length - 1], segment[0])) {
      current = [segment[0], segment[1]];
      paths.push(current);
    } else {
      current.push(segment[1]);
    }
  }
  return paths;
}

function clipSegment(
  start: { x: number; z: number },
  end: { x: number; z: number },
  halfWidth: number,
  halfDepth: number,
): [{ x: number; z: number }, { x: number; z: number }] | undefined {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  let minimum = 0;
  let maximum = 1;
  const tests: Array<[number, number]> = [
    [-dx, start.x + halfWidth],
    [dx, halfWidth - start.x],
    [-dz, start.z + halfDepth],
    [dz, halfDepth - start.z],
  ];
  for (const [direction, distance] of tests) {
    if (direction === 0) {
      if (distance < 0) return undefined;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return undefined;
  }
  return [
    { x: start.x + minimum * dx, z: start.z + minimum * dz },
    { x: start.x + maximum * dx, z: start.z + maximum * dz },
  ];
}

function samePoint(a: { x: number; z: number }, b: { x: number; z: number }): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
}

function tileFor(longitude: number, latitude: number, zoom: number): { x: number; y: number } {
  const scale = 2 ** zoom;
  const latitudeRadians = latitude * Math.PI / 180;
  return {
    x: Math.floor((longitude + 180) / 360 * scale),
    y: Math.floor((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale),
  };
}

function tileBounds(x: number, y: number, zoom: number): TileBounds {
  const scale = 2 ** zoom;
  return {
    lonWest: x / scale * 360 - 180,
    lonEast: (x + 1) / scale * 360 - 180,
    latNorth: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / scale))) * 180 / Math.PI,
    latSouth: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / scale))) * 180 / Math.PI,
  };
}
