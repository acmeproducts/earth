import {
  Color3,
  Mesh,
  MeshBuilder,
  PolygonMeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector2,
  Vector3,
} from "@babylonjs/core";
import { VectorTile, VectorTileFeature } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import earcut from "earcut";
import {
  HorizontalExclusionMask,
  lonLatToScene,
  sampleElevation,
  SEA_LEVEL_METERS,
} from "./Geo";
import type { TerrainData } from "./TerrainData";
import type { TileBounds } from "./WorldGrid";

export interface MapTile {
  x: number;
  y: number;
  zoom: number;
  data: VectorTile;
}

type LonLat = [number, number];

const BUILDING_GROUND_OVERLAP_METERS = 1;
const LAKE_SURFACE_CLEARANCE_METERS = 0.35;
const MINIMUM_LAKE_ELEVATION_METERS = SEA_LEVEL_METERS + 1;

interface MapLayerOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  lakeElevationSource?: Float32Array;
  /** Creates the layer hidden so partially built meshes never flash on screen. */
  startDisabled?: boolean;
  /**
   * Restricts the layer to features whose first vertex lies inside these
   * bounds. Streamed tiles share provider vector tiles, so without one owner
   * per feature every neighboring tile would rebuild the same geometry.
   */
  ownerBounds?: TileBounds;
}

interface MapClipBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface RoadSegment {
  start: { x: number; z: number };
  end: { x: number; z: number };
  halfWidth: number;
}

class RoadExclusionMask implements HorizontalExclusionMask {
  private readonly cells = new Map<string, RoadSegment[]>();

  constructor(segments: RoadSegment[], private readonly cellSize: number) {
    for (const segment of segments) {
      const minimumX = Math.floor((Math.min(segment.start.x, segment.end.x) - segment.halfWidth) / cellSize);
      const maximumX = Math.floor((Math.max(segment.start.x, segment.end.x) + segment.halfWidth) / cellSize);
      const minimumZ = Math.floor((Math.min(segment.start.z, segment.end.z) - segment.halfWidth) / cellSize);
      const maximumZ = Math.floor((Math.max(segment.start.z, segment.end.z) + segment.halfWidth) / cellSize);
      for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ++) {
        for (let cellX = minimumX; cellX <= maximumX; cellX++) {
          const key = `${cellX},${cellZ}`;
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
        const segments = this.cells.get(`${cellX},${cellZ}`);
        if (!segments) continue;
        for (const segment of segments) {
          const clearance = segment.halfWidth + radius;
          if (pointSegmentDistanceSquared(x, z, segment.start, segment.end) <= clearance * clearance) {
            return true;
          }
        }
      }
    }
    return false;
  }
}

export interface MapFeatureLayer {
  root: TransformNode;
  meshes: Mesh[];
  counts: { buildings: number; roads: number; water: number };
}

export class OpenStreetMap {
  private static readonly ZOOM = 14;
  private static readonly TILE_URL = "https://tiles.openfreemap.org/planet/latest";
  private static readonly cache = new Map<string, Promise<VectorTile | undefined>>();

  static async fetch(bounds: TileBounds, zoom = this.ZOOM): Promise<MapTile[]> {
    const northWest = tileFor(bounds.lonWest, bounds.latNorth, zoom);
    // Terrain bounds commonly end exactly on a slippy-tile boundary. Treat the
    // east and south edges as exclusive so we do not fetch an unused extra row
    // and column of vector tiles.
    const southEast = tileFor(bounds.lonEast - 1e-10, bounds.latSouth + 1e-10, zoom);
    const requests: Array<Promise<MapTile | undefined>> = [];
    for (let x = northWest.x; x <= southEast.x; x++) {
      for (let y = northWest.y; y <= southEast.y; y++) {
        requests.push(this.fetchTile(x, y, zoom));
      }
    }
    return (await Promise.all(requests)).filter((tile): tile is MapTile => tile !== undefined);
  }

  static async createLayer(
    scene: Scene,
    tiles: MapTile[],
    terrain: TerrainData,
    options: MapLayerOptions,
    yieldControl?: () => Promise<void>,
  ): Promise<MapFeatureLayer> {
    const root = new TransformNode("mapFeatures", scene);
    if (options.startDisabled) root.setEnabled(false);
    const buildings: Mesh[] = [];
    const roads: Mesh[] = [];
    const water: Mesh[] = [];

    for (const tile of tiles) {
      forEachFeature(tile, "building", (feature) => {
        const height = numericProperty(feature, "render_height") || 8;
        for (const polygon of polygons(feature, tile)) {
          if (!ownsGeometry(polygon, options.ownerBounds)) continue;
          const mesh = createPolygon(scene, polygon, terrain, options, height);
          if (mesh) buildings.push(mesh);
        }
      });
      await yieldControl?.();
      forEachFeature(tile, "transportation", (feature) => {
        const width = roadWidth(String(feature.properties.class ?? ""));
        for (const line of lines(feature, tile)) {
          if (!ownsGeometry(line, options.ownerBounds)) continue;
          roads.push(...createRoad(scene, line, terrain, options, width));
        }
      });
      await yieldControl?.();
      forEachFeature(tile, "water", (feature) => {
        if (feature.properties.class === "ocean") return;
        for (const polygon of polygons(feature, tile)) {
          if (!ownsGeometry(polygon, options.ownerBounds)) continue;
          const mesh = createPolygon(scene, polygon, terrain, options, 0.1, true);
          if (mesh) water.push(mesh);
        }
      });
      await yieldControl?.();
    }

    const meshes = [
      merge(buildings, "buildings", new Color3(0.56, 0.53, 0.48), root),
      merge(roads, "roads", new Color3(0.22, 0.22, 0.21), root),
      ...styleWater(water, root),
    ].filter((mesh): mesh is Mesh => mesh !== undefined);
    // Source meshes are disabled as soon as they are constructed so yielding
    // between feature batches cannot expose them at the scene origin. The
    // merged meshes can now be enabled safely: a streamed layer's disabled
    // root keeps them hidden until Game applies the tile offset and commits it.
    for (const mesh of meshes) mesh.setEnabled(true);
    return {
      root,
      meshes,
      counts: { buildings: buildings.length, roads: roads.length, water: water.length },
    };
  }

  static async createRoadExclusionMask(
    tiles: MapTile[],
    terrain: TerrainData,
    options: MapLayerOptions,
    yieldControl?: () => Promise<void>,
  ): Promise<HorizontalExclusionMask> {
    const segments: RoadSegment[] = [];
    for (const tile of tiles) {
      forEachFeature(tile, "transportation", (feature) => {
        const halfWidth = roadWidth(String(feature.properties.class ?? "")) / options.metersPerUnit / 2;
        for (const coordinates of lines(feature, tile)) {
          const points = coordinates.map(([lon, lat]) =>
            lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
          );
          for (let index = 1; index < points.length; index++) {
            segments.push({ start: points[index - 1], end: points[index], halfWidth });
          }
        }
      });
      await yieldControl?.();
    }
    return new RoadExclusionMask(segments, Math.max(0.25, 20 / options.metersPerUnit));
  }

  private static async fetchTile(x: number, y: number, zoom: number): Promise<MapTile | undefined> {
    const key = `${zoom}/${x}/${y}`;
    let request = this.cache.get(key);
    if (!request) {
      request = fetch(`${this.TILE_URL}/${key}.pbf`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`Map tile request failed (${response.status}).`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          return bytes.length ? new VectorTile(new PbfReader(bytes)) : undefined;
        }).catch((error: unknown) => {
          this.cache.delete(key);
          throw error;
        });
      this.cache.set(key, request);
    }
    const data = await request;
    return data ? { x, y, zoom, data } : undefined;
  }
}

/**
 * One streamed tile owns each feature piece: the tile containing its first
 * vertex. The geometry itself is projected from absolute coordinates, so an
 * owned road or building still renders correctly across tile boundaries.
 */
function ownsGeometry(points: LonLat[], bounds?: TileBounds): boolean {
  if (!bounds) return true;
  if (points.length === 0) return false;
  const [lon, lat] = points[0];
  return lon >= bounds.lonWest && lon < bounds.lonEast &&
    lat > bounds.latSouth && lat <= bounds.latNorth;
}

function forEachFeature(tile: MapTile, layerName: string, visit: (feature: VectorTileFeature) => void): void {
  const layer = tile.data.layers[layerName];
  if (!layer) return;
  for (let index = 0; index < layer.length; index++) visit(layer.feature(index));
}

function polygons(feature: VectorTileFeature, tile: MapTile): LonLat[][] {
  const geometry = feature.toGeoJSON(tile.x, tile.y, tile.zoom).geometry;
  if (geometry.type === "Polygon") return [geometry.coordinates[0] as LonLat[]];
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.map((polygon) => polygon[0] as LonLat[]);
  }
  return [];
}

function lines(feature: VectorTileFeature, tile: MapTile): LonLat[][] {
  const geometry = feature.toGeoJSON(tile.x, tile.y, tile.zoom).geometry;
  if (geometry.type === "LineString") return [geometry.coordinates as LonLat[]];
  if (geometry.type === "MultiLineString") return geometry.coordinates as LonLat[][];
  return [];
}

function polygonScenePoints(
  coordinates: LonLat[],
  terrain: TerrainData,
  options: MapLayerOptions,
): Array<{ x: number; z: number }> {
  return coordinates.map(([lon, lat]) =>
    lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
  );
}

function createPolygon(
  scene: Scene,
  coordinates: LonLat[],
  terrain: TerrainData,
  options: MapLayerOptions,
  heightMeters: number,
  isWater = false,
): Mesh | undefined {
  const points = polygonScenePoints(coordinates, terrain, options);
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  const clipped = clipPolygon(points, {
    minX: -options.meshWidth / 2,
    maxX: options.meshWidth / 2,
    minZ: -options.meshDepth / 2,
    maxZ: options.meshDepth / 2,
  });
  if (clipped.length < 3) return undefined;
  if (signedArea(clipped) < 0) clipped.reverse();
  const center = averagePoint(clipped);
  const elevationSource = isWater && options.lakeElevationSource
    ? options.lakeElevationSource
    : terrain.elevations;
  const centerElevation = sampleElevation(
    terrain,
    center.x,
    center.z,
    options.meshWidth,
    options.meshDepth,
    elevationSource,
  );
  const boundaryElevations = clipped.map((point) =>
    sampleElevation(terrain, point.x, point.z, options.meshWidth, options.meshDepth, elevationSource)
  );
  if (!isWater && (
    centerElevation <= SEA_LEVEL_METERS ||
    boundaryElevations.some((elevation) => elevation <= SEA_LEVEL_METERS)
  )) return undefined;
  const baseElevation = Math.max(
    centerElevation,
    ...boundaryElevations,
  );
  if (!isWater) {
    const shape = clipped.map(({ x, z }) => new Vector2(x, z));
    const roofElevation = baseElevation + heightMeters;
    const bottomElevation = terrain.minElevation - BUILDING_GROUND_OVERLAP_METERS;
    const depth = (roofElevation - bottomElevation) / options.metersPerUnit;
    const mesh = stageMapMesh(
      new PolygonMeshBuilder("building", shape, scene, earcut).build(false, depth),
    );
    mesh.position.y = roofElevation / options.metersPerUnit;
    return mesh;
  }
  const lakeElevation = quantile([centerElevation, ...boundaryElevations], 0.25);
  // Reject coastal/sea-level OSM water polygons. The lower quartile keeps a few
  // elevated shoreline samples from making a sea-level polygon look inland.
  if (lakeElevation < MINIMUM_LAKE_ELEVATION_METERS) return undefined;
  const shape = clipped.map(({ x, z }) => new Vector2(x, z));
  const surfaceElevation = lakeElevation + LAKE_SURFACE_CLEARANCE_METERS;
  const surface = surfaceElevation / options.metersPerUnit;
  const mesh = stageMapMesh(
    new PolygonMeshBuilder("water", shape, scene, earcut).build(false),
  );
  mesh.position.y = surface;
  return mesh;
}

function createRoad(
  scene: Scene,
  coordinates: LonLat[],
  terrain: TerrainData,
  options: MapLayerOptions,
  widthMeters: number,
): Mesh[] {
  const points = coordinates.map(([lon, lat]) =>
    lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth),
  );
  const halfWidth = widthMeters / options.metersPerUnit / 2;
  const paths = clipPolyline(
    points,
    options.meshWidth / 2 - halfWidth,
    options.meshDepth / 2 - halfWidth,
  );
  const sampleSpacing = Math.min(
    options.meshWidth / Math.max(1, terrain.width - 1),
    options.meshDepth / Math.max(1, terrain.height - 1),
  ) / 2;
  return paths.flatMap((path) =>
    createRoadMeshes(scene, resamplePath(path, sampleSpacing), terrain, options, halfWidth)
  );
}

function createRoadMeshes(
  scene: Scene,
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: MapLayerOptions,
  halfWidth: number,
): Mesh[] {
  const meshes: Mesh[] = [];
  let left: Vector3[] = [];
  let right: Vector3[] = [];
  const finishPath = (): void => {
    if (left.length >= 2) {
      meshes.push(stageMapMesh(
        MeshBuilder.CreateRibbon("road", { pathArray: [left, right] }, scene),
      ));
    }
    left = [];
    right = [];
  };
  for (let index = 0; index < points.length; index++) {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    const offsetX = (-dz / length) * halfWidth;
    const offsetZ = (dx / length) * halfWidth;
    const leftElevation = sampleElevation(
      terrain,
      points[index].x + offsetX,
      points[index].z + offsetZ,
      options.meshWidth,
      options.meshDepth,
    );
    const rightElevation = sampleElevation(
      terrain,
      points[index].x - offsetX,
      points[index].z - offsetZ,
      options.meshWidth,
      options.meshDepth,
    );
    if (leftElevation <= SEA_LEVEL_METERS || rightElevation <= SEA_LEVEL_METERS) {
      finishPath();
      continue;
    }
    left.push(new Vector3(
      points[index].x + offsetX,
      leftElevation / options.metersPerUnit + 0.025,
      points[index].z + offsetZ,
    ));
    right.push(new Vector3(
      points[index].x - offsetX,
      rightElevation / options.metersPerUnit + 0.025,
      points[index].z - offsetZ,
    ));
  }
  finishPath();
  return meshes;
}

/** Keeps a newly registered Babylon mesh out of render lists while its tile is assembled. */
function stageMapMesh<T extends Mesh>(mesh: T): T {
  mesh.setEnabled(false);
  return mesh;
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

function clipPolygon(
  points: Array<{ x: number; z: number }>,
  bounds: MapClipBounds,
): Array<{ x: number; z: number }> {
  const edges: Array<{
    inside: (point: { x: number; z: number }) => boolean;
    intersect: (start: { x: number; z: number }, end: { x: number; z: number }) => { x: number; z: number };
  }> = [
    { inside: (p) => p.x >= bounds.minX, intersect: (a, b) => atX(a, b, bounds.minX) },
    { inside: (p) => p.x <= bounds.maxX, intersect: (a, b) => atX(a, b, bounds.maxX) },
    { inside: (p) => p.z >= bounds.minZ, intersect: (a, b) => atZ(a, b, bounds.minZ) },
    { inside: (p) => p.z <= bounds.maxZ, intersect: (a, b) => atZ(a, b, bounds.maxZ) },
  ];
  let output = points;
  for (const edge of edges) {
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index++) {
      const start = input[(index + input.length - 1) % input.length];
      const end = input[index];
      const startInside = edge.inside(start);
      const endInside = edge.inside(end);
      if (endInside) {
        if (!startInside) output.push(edge.intersect(start, end));
        output.push(end);
      } else if (startInside) {
        output.push(edge.intersect(start, end));
      }
    }
  }
  return output;
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

function atX(
  start: { x: number; z: number },
  end: { x: number; z: number },
  x: number,
): { x: number; z: number } {
  const amount = (x - start.x) / (end.x - start.x);
  return { x, z: start.z + amount * (end.z - start.z) };
}

function atZ(
  start: { x: number; z: number },
  end: { x: number; z: number },
  z: number,
): { x: number; z: number } {
  const amount = (z - start.z) / (end.z - start.z);
  return { x: start.x + amount * (end.x - start.x), z };
}

function signedArea(points: Array<{ x: number; z: number }>): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.z - next.x * points[index].z;
  }
  return area / 2;
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

function numericProperty(feature: VectorTileFeature, name: string): number {
  const value = Number(feature.properties[name]);
  return Number.isFinite(value) ? value : 0;
}

function averagePoint(points: Array<{ x: number; z: number }>): { x: number; z: number } {
  const total = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }),
    { x: 0, z: 0 },
  );
  return { x: total.x / points.length, z: total.z / points.length };
}

function quantile(values: number[], amount: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * amount));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const blend = position - lower;
  return sorted[lower] * (1 - blend) + sorted[upper] * blend;
}

function roadWidth(type: string): number {
  const widths: Record<string, number> = {
    motorway: 10,
    trunk: 9,
    primary: 8,
    secondary: 7,
    tertiary: 6,
    minor: 4,
    service: 3,
    path: 1.2,
  };
  return widths[type] ?? 3;
}

function merge(
  meshes: Mesh[],
  name: string,
  color: Color3,
  parent: TransformNode,
  alpha = 1,
): Mesh | undefined {
  if (meshes.length === 0) return undefined;
  const result = meshes.length === 1 ? meshes[0] : Mesh.MergeMeshes(meshes, true, true);
  if (!result) return undefined;
  const meshMaterial = new StandardMaterial(`${name}Material`, result.getScene());
  meshMaterial.diffuseColor = color;
  meshMaterial.specularColor = Color3.Black();
  meshMaterial.alpha = alpha;
  result.name = name;
  result.material = meshMaterial;
  result.parent = parent;
  return result;
}

function styleWater(meshes: Mesh[], parent: TransformNode): Mesh[] {
  if (meshes.length === 0) return [];
  const material = new StandardMaterial("inlandWaterMaterial", parent.getScene());
  material.diffuseColor = new Color3(0.05, 0.32, 0.5);
  material.specularColor = Color3.Black();
  material.alpha = 0.82;
  meshes.forEach((mesh, index) => {
    mesh.name = `inlandWater-${index}`;
    mesh.material = material;
    mesh.parent = parent;
  });
  return meshes;
}
