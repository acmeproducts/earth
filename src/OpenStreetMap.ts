import {
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PolygonMeshBuilder,
  RawTexture,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector2,
  Vector3,
  VertexBuffer,
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
import {
  BuildingDetailLevel,
  BuildingSource,
  LonLat,
  planBuilding,
} from "./BuildingPlanner";
import { ProceduralBuildingRenderer } from "./ProceduralBuildingRenderer";
import {
  expandLakeShoreline,
  prepareLakeSurfacePiece,
  styleLakeSurfaces,
} from "./LakeSurface";
import type { LakeSurfaceOptions } from "./LakeSurface";
import {
  createWaterSurfaceMaterial,
  prepareWaterSurfaceMesh,
} from "./Water";
import {
  planRoad,
  RoadPlan,
  RoadSurface,
  RoadVisualStyle,
} from "./RoadPlanner";
import { conformTerrainToRoads as stampRoadTerrain } from "./RoadTerrain";
import { conformTerrainToBuildings as stampBuildingTerrain } from "./BuildingTerrain";
import { createOpenStreetMapLandCover } from "./OpenStreetMapLandCover";
import type { LandCoverSampler } from "./WorldCover";

export interface MapTile {
  x: number;
  y: number;
  zoom: number;
  data: VectorTile;
}

const MINIMUM_LAKE_ELEVATION_METERS = SEA_LEVEL_METERS + 1;
/** Enough separation to avoid z-fighting without making roads hover. */
const ROAD_SURFACE_CLEARANCE_METERS = 0.025;
const ROAD_SHOULDER_CLEARANCE_METERS = 0.012;
const BRIDGE_DECK_THICKNESS_METERS = 0.32;
const BRIDGE_EDGE_WIDTH_METERS = 0.45;
const BRIDGE_TERRAIN_CLEARANCE_METERS = 0.15;
const BRIDGE_WATER_CLEARANCE_METERS = 3;
const WATERWAY_SURFACE_CLEARANCE_METERS = 0.08;
const ROAD_TEXTURE_SIZE = 64;

type RoadMaterialStyle = RoadVisualStyle | "pavedShoulder" | "unpavedShoulder" | "bridgeDeck";

interface RoadSource {
  id: string;
  paths: LonLat[][];
  properties: Readonly<Record<string, unknown>>;
}

const buildingSourceCache = new WeakMap<VectorTile, readonly BuildingSource[]>();
const roadSourceCache = new WeakMap<VectorTile, readonly RoadSource[]>();

interface MapLayerOptions extends LakeSurfaceOptions {
  lakeElevationSource?: Float32Array;
  /** Creates the layer hidden so partially built meshes never flash on screen. */
  startDisabled?: boolean;
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
  private readonly cellSize: number;

  constructor(segments: RoadSegment[], cellSize: number) {
    this.cellSize = cellSize;
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

interface CreatedRoad {
  surfaces: Mesh[];
  shoulders: Mesh[];
  bridgeDecks: Mesh[];
  paths: Array<Array<{ x: number; z: number }>>;
}

interface RoadJunctionCandidate {
  sourceId: string;
  point: { x: number; z: number };
  halfWidth: number;
  layer: number;
  visualStyle: RoadVisualStyle;
}

export interface BuildingFeatureLayer {
  root: TransformNode;
  meshes: Mesh[];
  count: number;
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
    const roadMeshes: Record<RoadVisualStyle, Mesh[]> = {
      marked: [],
      paved: [],
      pedestrian: [],
      unpaved: [],
      ford: [],
    };
    const roadShoulders: Record<RoadSurface, Mesh[]> = {
      paved: [],
      unpaved: [],
    };
    const bridgeDecks: Mesh[] = [];
    const junctionCandidates: RoadJunctionCandidate[] = [];
    const water: Mesh[] = [];
    const waterways: Mesh[] = [];

    for (const tile of tiles) {
      for (const source of buildingSources(tile)) {
        const mesh = ProceduralBuildingRenderer.createDetailed(
          scene,
          planBuilding(source),
          terrain,
          options,
        );
        if (mesh) buildings.push(mesh);
      }
      await yieldControl?.();
      for (const source of roadSources(tile)) {
        const appearance = planRoad(source.properties);
        if (!appearance || appearance.isTunnel) continue;
        const target = roadMeshes[appearance.visualStyle];
        for (const line of source.paths) {
          const created = createRoad(scene, line, terrain, options, appearance);
          target.push(...created.surfaces);
          roadShoulders[appearance.surface].push(...created.shoulders);
          bridgeDecks.push(...created.bridgeDecks);
          if (appearance.structure === "surface" || appearance.structure === "ford") {
            for (const path of created.paths) {
              if (path.length < 2) continue;
              for (const point of [path[0], path[path.length - 1]]) {
                junctionCandidates.push({
                  sourceId: source.id,
                  point,
                  halfWidth: appearance.widthMeters / options.metersPerUnit / 2,
                  layer: appearance.layer,
                  visualStyle: appearance.visualStyle,
                });
              }
            }
          }
        }
      }
      await yieldControl?.();
      forEachFeature(tile, "water", (feature, featureIndex) => {
        if (feature.properties.class === "ocean" || truthy(feature.properties.intermittent)) return;
        const waterPolygons = polygons(feature, tile);
        for (let polygonIndex = 0; polygonIndex < waterPolygons.length; polygonIndex++) {
          const lakeKey = waterFeatureSourceId(
            feature,
            tile,
            featureIndex,
            polygonIndex,
          );
          const mesh = createWaterPolygon(
            scene,
            waterPolygons[polygonIndex],
            terrain,
            options,
            lakeKey,
          );
          if (mesh) water.push(mesh);
        }
      });
      forEachFeature(tile, "waterway", (feature) => {
        if (truthy(feature.properties.intermittent)) return;
        const widthMeters = waterwayWidthMeters(feature.properties.class);
        if (widthMeters === undefined) return;
        for (const line of lines(feature, tile)) {
          waterways.push(...createWaterway(scene, line, terrain, options, widthMeters));
        }
      });
      await yieldControl?.();
    }

    for (const junction of createRoadJunctions(
      scene,
      junctionCandidates,
      terrain,
      options,
    )) {
      roadMeshes[junction.visualStyle].push(junction.mesh);
    }

    const meshes = [
      ProceduralBuildingRenderer.merge(buildings, "buildings", root),
      mergeRoads(roadShoulders.paved, "pavedRoadShoulders", "pavedShoulder", root),
      mergeRoads(roadShoulders.unpaved, "unpavedRoadShoulders", "unpavedShoulder", root),
      mergeRoads(bridgeDecks, "bridgeDecks", "bridgeDeck", root),
      mergeRoads(roadMeshes.marked, "markedRoads", "marked", root),
      mergeRoads(roadMeshes.paved, "pavedRoads", "paved", root),
      mergeRoads(roadMeshes.pedestrian, "pedestrianRoads", "pedestrian", root),
      mergeRoads(roadMeshes.unpaved, "unpavedRoads", "unpaved", root),
      mergeRoads(roadMeshes.ford, "fordRoads", "ford", root),
      mergeWaterways(waterways, root, options),
      ...styleLakeSurfaces(water, root, options),
    ].filter((mesh): mesh is Mesh => mesh !== undefined);
    // Source meshes are disabled as soon as they are constructed so yielding
    // between feature batches cannot expose them at the scene origin. The
    // merged meshes can now be enabled safely: a streamed layer's disabled
    // root keeps them hidden until Game applies the tile offset and commits it.
    for (const mesh of meshes) mesh.setEnabled(true);
    return {
      root,
      meshes,
      counts: {
        buildings: buildings.length,
        roads: Object.values(roadMeshes).reduce((sum, meshes) => sum + meshes.length, 0),
        water: water.length + waterways.length,
      },
    };
  }

  static async createBuildingLayer(
    scene: Scene,
    tiles: MapTile[],
    terrain: TerrainData,
    options: MapLayerOptions,
    detail: BuildingDetailLevel,
    yieldControl?: () => Promise<void>,
  ): Promise<BuildingFeatureLayer> {
    const name = detail === "far" ? "farBuildings" : "detailedBuildings";
    const root = new TransformNode(name, scene);
    if (options.startDisabled) root.setEnabled(false);
    const buildings: Mesh[] = [];
    for (const tile of tiles) {
      for (const source of buildingSources(tile)) {
        const plan = planBuilding(source);
        const mesh = detail === "far"
          ? ProceduralBuildingRenderer.createFar(scene, plan, terrain, options)
          : ProceduralBuildingRenderer.createDetailed(scene, plan, terrain, options);
        if (mesh) buildings.push(mesh);
      }
      await yieldControl?.();
    }

    const merged = ProceduralBuildingRenderer.merge(buildings, name, root);
    const meshes = merged ? [merged] : [];
    for (const mesh of meshes) mesh.setEnabled(true);
    return { root, meshes, count: buildings.length };
  }

  static async createRoadExclusionMask(
    tiles: MapTile[],
    terrain: TerrainData,
    options: MapLayerOptions,
    yieldControl?: () => Promise<void>,
  ): Promise<HorizontalExclusionMask> {
    const segments: RoadSegment[] = [];
    for (const tile of tiles) {
      for (const source of roadSources(tile)) {
        const appearance = planRoad(source.properties);
        if (!appearance || appearance.isTunnel) continue;
        const halfWidth = (
          appearance.widthMeters / 2 + appearance.shoulderWidthMeters
        ) / options.metersPerUnit;
        for (const coordinates of source.paths) {
          const points = coordinates.map(([lon, lat]) =>
            lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
          );
          for (let index = 1; index < points.length; index++) {
            segments.push({ start: points[index - 1], end: points[index], halfWidth });
          }
        }
      }
      await yieldControl?.();
    }
    return new RoadExclusionMask(segments, Math.max(0.25, 20 / options.metersPerUnit));
  }

  static async conformTerrainToRoads(
    tiles: MapTile[],
    terrain: TerrainData,
    options: Pick<MapLayerOptions, "meshWidth" | "meshDepth" | "metersPerUnit">,
    yieldControl?: () => Promise<void>,
  ): Promise<number> {
    const paths = [];
    for (const tile of tiles) {
      for (const source of roadSources(tile)) {
        const appearance = planRoad(source.properties);
        if (!appearance || appearance.isTunnel || appearance.structure === "bridge") continue;
        for (const coordinates of source.paths) {
          const scenePoints = coordinates.map(([lon, lat]) =>
            lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
          );
          for (const points of clipPolyline(
            scenePoints,
            options.meshWidth / 2,
            options.meshDepth / 2,
          )) {
            paths.push({
              points,
              widthMeters: appearance.widthMeters,
              shoulderWidthMeters: appearance.shoulderWidthMeters,
              structure: appearance.structure,
            });
          }
        }
      }
      await yieldControl?.();
    }
    return stampRoadTerrain(terrain, paths, options, yieldControl);
  }

  static async conformTerrainToBuildings(
    tiles: MapTile[],
    terrain: TerrainData,
    options: Pick<MapLayerOptions, "meshWidth" | "meshDepth" | "metersPerUnit">,
    yieldControl?: () => Promise<void>,
  ): Promise<number> {
    const footprints = [];
    for (const tile of tiles) {
      for (const source of buildingSources(tile)) {
        footprints.push({
          outline: source.polygon.outer.map(([lon, lat]) =>
            lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
          ),
        });
      }
      await yieldControl?.();
    }
    return stampBuildingTerrain(terrain, footprints, options, yieldControl);
  }

  static createLandCoverSampler(
    tiles: readonly MapTile[],
    fallback: LandCoverSampler | undefined,
  ): LandCoverSampler | undefined {
    return createOpenStreetMapLandCover(tiles, fallback);
  }

  /** Disposes a streamed layer without taking down its scene-owned sky map. */
  static disposeLayer(root: TransformNode): void {
    for (const mesh of root.getChildMeshes(false)) {
      if (mesh.material instanceof PBRMaterial || mesh.material instanceof StandardMaterial) {
        mesh.material.reflectionTexture = null;
      }
    }
    root.dispose(false, true);
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

function forEachFeature(
  tile: MapTile,
  layerName: string,
  visit: (feature: VectorTileFeature, index: number) => void,
): void {
  const layer = tile.data.layers[layerName];
  if (!layer) return;
  for (let index = 0; index < layer.length; index++) visit(layer.feature(index), index);
}

function buildingSources(tile: MapTile): readonly BuildingSource[] {
  const cached = buildingSourceCache.get(tile.data);
  if (cached) return cached;
  const sources: BuildingSource[] = [];
  forEachFeature(tile, "building", (feature, featureIndex) => {
    if (truthy(feature.properties.hide_3d)) return;
    const geometry = feature.toGeoJSON(tile.x, tile.y, tile.zoom).geometry;
    const sourcePolygons = geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
    for (let polygonIndex = 0; polygonIndex < sourcePolygons.length; polygonIndex++) {
      const rings = sourcePolygons[polygonIndex] as LonLat[][];
      if (rings.length === 0) continue;
      sources.push({
        id: featureSourceId("building", feature, tile, featureIndex, polygonIndex),
        polygon: { outer: rings[0], holes: rings.slice(1) },
        properties: { ...feature.properties },
      });
    }
  });
  buildingSourceCache.set(tile.data, sources);
  return sources;
}

function roadSources(tile: MapTile): readonly RoadSource[] {
  const cached = roadSourceCache.get(tile.data);
  if (cached) return cached;
  const sources: RoadSource[] = [];
  forEachFeature(tile, "transportation", (feature, featureIndex) => {
    const paths = lines(feature, tile);
    if (paths.length === 0) return;
    sources.push({
      id: featureSourceId("road", feature, tile, featureIndex),
      paths,
      properties: { ...feature.properties },
    });
  });
  roadSourceCache.set(tile.data, sources);
  return sources;
}

function featureSourceId(
  kind: string,
  feature: VectorTileFeature,
  tile: MapTile,
  featureIndex: number,
  part = 0,
): string {
  const id = feature.id === undefined
    ? `${tile.x}/${tile.y}/${featureIndex}`
    : String(feature.id);
  return `${kind}/${tile.zoom}/${id}/${part}`;
}

/** OSM water IDs remain stable when one lake is clipped into provider tiles. */
function waterFeatureSourceId(
  feature: VectorTileFeature,
  tile: MapTile,
  featureIndex: number,
  part: number,
): string {
  return feature.id === undefined
    ? featureSourceId("water", feature, tile, featureIndex, part)
    : `water/${tile.zoom}/${String(feature.id)}`;
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

function createWaterPolygon(
  scene: Scene,
  coordinates: LonLat[],
  terrain: TerrainData,
  options: MapLayerOptions,
  lakeKey?: string,
): Mesh | undefined {
  const points = polygonScenePoints(coordinates, terrain, options);
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  const clipBounds = {
    minX: -options.meshWidth / 2,
    maxX: options.meshWidth / 2,
    minZ: -options.meshDepth / 2,
    maxZ: options.meshDepth / 2,
  };
  const expanded = expandLakeShoreline(points, terrain, options);
  const clipped = clipPolygon(expanded, clipBounds);
  if (clipped.length < 3) return undefined;
  if (signedArea(clipped) < 0) clipped.reverse();
  // The expanded ring is only visual underlap. Sampling it would mix elevated
  // banks into the shared lake level, so prefer the real mapped footprint.
  const mappedFootprint = clipPolygon(points, clipBounds);
  const elevationPoints = mappedFootprint.length >= 3 ? mappedFootprint : clipped;
  const center = averagePoint(elevationPoints);
  const elevationSource = options.lakeElevationSource
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
  const boundaryElevations = elevationPoints.map((point) =>
    sampleElevation(terrain, point.x, point.z, options.meshWidth, options.meshDepth, elevationSource)
  );
  const lakeElevation = quantile([centerElevation, ...boundaryElevations], 0.25);
  // Reject coastal/sea-level OSM water polygons. The lower quartile keeps a few
  // elevated shoreline samples from making a sea-level polygon look inland.
  if (lakeElevation < MINIMUM_LAKE_ELEVATION_METERS) return undefined;
  const shape = clipped.map(({ x, z }) => new Vector2(x, z));
  const mesh = stageMapMesh(
    new PolygonMeshBuilder("water", shape, scene, earcut).build(false),
  );
  prepareLakeSurfacePiece(
    mesh,
    terrain,
    options,
    lakeKey ?? `water/${terrain.worldTile.level}/${terrain.worldTile.x}/${terrain.worldTile.y}`,
    lakeElevation,
  );
  return mesh;
}

function createRoad(
  scene: Scene,
  coordinates: LonLat[],
  terrain: TerrainData,
  options: MapLayerOptions,
  appearance: RoadPlan,
): CreatedRoad {
  const points = coordinates.map(([lon, lat]) =>
    lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth),
  );
  const halfWidth = appearance.widthMeters / options.metersPerUnit / 2;
  const clippedPaths = clipPolyline(
    points,
    options.meshWidth / 2,
    options.meshDepth / 2,
  );
  const sampleSpacing = Math.min(
    options.meshWidth / Math.max(1, terrain.width - 1),
    options.meshDepth / Math.max(1, terrain.height - 1),
  ) / 2;
  const paths = clippedPaths.map((path) => resamplePath(path, sampleSpacing));
  const surfaces: Mesh[] = [];
  const shoulders: Mesh[] = [];
  const bridgeDecks: Mesh[] = [];
  for (const path of paths) {
    const bridgeElevations = appearance.structure === "bridge"
      ? bridgeElevationProfile(path, terrain, options)
      : undefined;
    surfaces.push(...createRoadMeshes(
      scene,
      path,
      terrain,
      options,
      halfWidth,
      appearance.visualStyle,
      ROAD_SURFACE_CLEARANCE_METERS,
      bridgeElevations,
    ));
    if (bridgeElevations) {
      bridgeDecks.push(...createRoadMeshes(
        scene,
        path,
        terrain,
        options,
        halfWidth + BRIDGE_EDGE_WIDTH_METERS / options.metersPerUnit,
        "paved",
        -BRIDGE_DECK_THICKNESS_METERS,
        bridgeElevations,
      ));
    } else {
      shoulders.push(...createRoadMeshes(
        scene,
        path,
        terrain,
        options,
        halfWidth + appearance.shoulderWidthMeters / options.metersPerUnit,
        appearance.surface,
        ROAD_SHOULDER_CLEARANCE_METERS,
      ));
    }
  }
  return { surfaces, shoulders, bridgeDecks, paths };
}

function createRoadMeshes(
  scene: Scene,
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: MapLayerOptions,
  halfWidth: number,
  visualStyle: RoadVisualStyle,
  clearanceMeters: number,
  centerElevations?: readonly number[],
): Mesh[] {
  const meshes: Mesh[] = [];
  let left: Vector3[] = [];
  let right: Vector3[] = [];
  const finishPath = (): void => {
    if (left.length >= 2) {
      const uvs = roadUvs(left, right, options.metersPerUnit, visualStyle);
      meshes.push(stageMapMesh(
        MeshBuilder.CreateRibbon("road", { pathArray: [left, right], uvs }, scene),
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
    const leftElevation = centerElevations?.[index] ?? sampleElevation(
        terrain,
        points[index].x + offsetX,
        points[index].z + offsetZ,
        options.meshWidth,
        options.meshDepth,
      );
    const rightElevation = centerElevations?.[index] ?? sampleElevation(
        terrain,
        points[index].x - offsetX,
        points[index].z - offsetZ,
        options.meshWidth,
        options.meshDepth,
      );
    left.push(new Vector3(
      points[index].x + offsetX,
      (leftElevation + clearanceMeters) / options.metersPerUnit,
      points[index].z + offsetZ,
    ));
    right.push(new Vector3(
      points[index].x - offsetX,
      (rightElevation + clearanceMeters) / options.metersPerUnit,
      points[index].z - offsetZ,
    ));
  }
  finishPath();
  return meshes;
}

function bridgeElevationProfile(
  points: readonly { x: number; z: number }[],
  terrain: TerrainData,
  options: MapLayerOptions,
): number[] {
  if (points.length === 0) return [];
  const observations = points.map((point) => {
    const ground = sampleElevation(
      terrain,
      point.x,
      point.z,
      options.meshWidth,
      options.meshDepth,
    );
    const water = sampleTerrainWaterMask(
      terrain,
      point.x,
      point.z,
      options.meshWidth,
      options.meshDepth,
    ) || ground <= SEA_LEVEL_METERS;
    const obstacle = water && options.lakeElevationSource
      ? sampleElevation(
        terrain,
        point.x,
        point.z,
        options.meshWidth,
        options.meshDepth,
        options.lakeElevationSource,
      )
      : ground;
    return { obstacle, clearance: water ? BRIDGE_WATER_CLEARANCE_METERS : BRIDGE_TERRAIN_CLEARANCE_METERS };
  });
  const startElevation = observations[0].obstacle;
  const endElevation = observations[observations.length - 1].obstacle;
  const baseline = observations.map((_, index) => {
    const amount = index / Math.max(1, observations.length - 1);
    return startElevation + (endElevation - startElevation) * amount;
  });
  const lift = observations.reduce(
    (maximum, observation, index) =>
      Math.max(maximum, observation.obstacle + observation.clearance - baseline[index]),
    0,
  );
  return baseline.map((elevation) => elevation + lift);
}

function sampleTerrainWaterMask(
  terrain: TerrainData,
  x: number,
  z: number,
  meshWidth: number,
  meshDepth: number,
): boolean {
  if (!terrain.waterMask) return false;
  const u = x / meshWidth + 0.5;
  const v = 0.5 - z / meshDepth;
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  const column = Math.round(u * (terrain.width - 1));
  const row = Math.round(v * (terrain.height - 1));
  return terrain.waterMask[row * terrain.width + column] === 1;
}

function createRoadJunctions(
  scene: Scene,
  candidates: readonly RoadJunctionCandidate[],
  terrain: TerrainData,
  options: MapLayerOptions,
): Array<{ mesh: Mesh; visualStyle: RoadVisualStyle }> {
  const tolerance = Math.max(1e-6, 0.25 / options.metersPerUnit);
  const groups = new Map<string, RoadJunctionCandidate[]>();
  for (const candidate of candidates) {
    const key = [
      Math.round(candidate.point.x / tolerance),
      Math.round(candidate.point.z / tolerance),
      candidate.layer,
    ].join("/");
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  const clipBounds = {
    minX: -options.meshWidth / 2,
    maxX: options.meshWidth / 2,
    minZ: -options.meshDepth / 2,
    maxZ: options.meshDepth / 2,
  };
  const junctions: Array<{ mesh: Mesh; visualStyle: RoadVisualStyle }> = [];
  for (const group of groups.values()) {
    if (new Set(group.map((candidate) => candidate.sourceId)).size < 2) continue;
    const center = group[0].point;
    const radius = Math.max(...group.map((candidate) => candidate.halfWidth)) +
      0.08 / options.metersPerUnit;
    const circle = Array.from({ length: 16 }, (_, index) => {
      const angle = index / 16 * Math.PI * 2;
      return {
        x: center.x + Math.cos(angle) * radius,
        z: center.z + Math.sin(angle) * radius,
      };
    });
    const clipped = clipPolygon(circle, clipBounds);
    if (clipped.length < 3) continue;
    if (signedArea(clipped) < 0) clipped.reverse();
    const mesh = new PolygonMeshBuilder(
      "roadJunction",
      clipped.map(({ x, z }) => new Vector2(x, z)),
      scene,
      earcut,
    ).build(true);
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) {
      mesh.dispose();
      continue;
    }
    for (let index = 0; index < positions.length; index += 3) {
      positions[index + 1] = (
        sampleElevation(
          terrain,
          positions[index],
          positions[index + 2],
          options.meshWidth,
          options.meshDepth,
        ) + ROAD_SURFACE_CLEARANCE_METERS
      ) / options.metersPerUnit;
    }
    mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
    mesh.refreshBoundingInfo();
    junctions.push({
      mesh: stageMapMesh(mesh),
      visualStyle: junctionVisualStyle(group),
    });
  }
  return junctions;
}

function junctionVisualStyle(candidates: readonly RoadJunctionCandidate[]): RoadVisualStyle {
  if (candidates.some((candidate) => candidate.visualStyle === "ford")) return "ford";
  if (candidates.every((candidate) => candidate.visualStyle === "unpaved")) return "unpaved";
  if (candidates.every((candidate) => candidate.visualStyle === "pedestrian")) return "pedestrian";
  return "paved";
}

function createWaterway(
  scene: Scene,
  coordinates: LonLat[],
  terrain: TerrainData,
  options: MapLayerOptions,
  widthMeters: number,
): Mesh[] {
  const points = coordinates.map(([lon, lat]) =>
    lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
  );
  const paths = clipPolyline(points, options.meshWidth / 2, options.meshDepth / 2);
  const sampleSpacing = Math.min(
    options.meshWidth / Math.max(1, terrain.width - 1),
    options.meshDepth / Math.max(1, terrain.height - 1),
  ) / 2;
  return paths.flatMap((path) => createWaterwayMeshes(
    scene,
    resamplePath(path, sampleSpacing),
    terrain,
    options,
    widthMeters / options.metersPerUnit / 2,
  ));
}

function createWaterwayMeshes(
  scene: Scene,
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: MapLayerOptions,
  halfWidth: number,
): Mesh[] {
  if (points.length < 2) return [];
  const left: Vector3[] = [];
  const right: Vector3[] = [];
  for (let index = 0; index < points.length; index++) {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    const offsetX = (-dz / length) * halfWidth;
    const offsetZ = (dx / length) * halfWidth;
    const elevation = Math.min(
      sampleElevation(terrain, points[index].x + offsetX, points[index].z + offsetZ, options.meshWidth, options.meshDepth),
      sampleElevation(terrain, points[index].x - offsetX, points[index].z - offsetZ, options.meshWidth, options.meshDepth),
    );
    const y = (elevation + WATERWAY_SURFACE_CLEARANCE_METERS) / options.metersPerUnit;
    left.push(new Vector3(points[index].x + offsetX, y, points[index].z + offsetZ));
    right.push(new Vector3(points[index].x - offsetX, y, points[index].z - offsetZ));
  }
  return [stageMapMesh(MeshBuilder.CreateRibbon(
    "waterway",
    { pathArray: [left, right], uvs: roadUvs(left, right, options.metersPerUnit, "paved") },
    scene,
  ))];
}

function waterwayWidthMeters(value: unknown): number | undefined {
  switch (String(value ?? "").toLowerCase()) {
    case "river": return 12;
    case "canal": return 5;
    case "stream": return 2;
    case "drain": return 1.2;
    case "ditch": return 0.8;
    default: return undefined;
  }
}

/** Gives road textures a stable real-world scale after ribbons are merged. */
function roadUvs(
  left: Vector3[],
  right: Vector3[],
  metersPerUnit: number,
  visualStyle: RoadVisualStyle,
): Vector2[] {
  const repeatMeters = visualStyle === "unpaved" || visualStyle === "ford" ? 1.5 : 4;
  const leftUvs = [new Vector2(0, 0)];
  const rightUvs = [new Vector2(0, 1)];
  let distanceMeters = 0;
  for (let index = 1; index < left.length; index++) {
    const previousX = (left[index - 1].x + right[index - 1].x) / 2;
    const previousZ = (left[index - 1].z + right[index - 1].z) / 2;
    const x = (left[index].x + right[index].x) / 2;
    const z = (left[index].z + right[index].z) / 2;
    distanceMeters += Math.hypot(x - previousX, z - previousZ) * metersPerUnit;
    const u = distanceMeters / repeatMeters;
    leftUvs.push(new Vector2(u, 0));
    rightUvs.push(new Vector2(u, 1));
  }
  return [...leftUvs, ...rightUvs];
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

function mergeRoads(
  meshes: Mesh[],
  name: string,
  visualStyle: RoadMaterialStyle,
  parent: TransformNode,
): Mesh | undefined {
  if (meshes.length === 0) return undefined;
  const result = meshes.length === 1 ? meshes[0] : Mesh.MergeMeshes(meshes, true, true);
  if (!result) return undefined;
  result.name = name;
  result.material = createRoadMaterial(result.getScene(), name, visualStyle);
  result.parent = parent;
  return result;
}

function mergeWaterways(
  meshes: Mesh[],
  parent: TransformNode,
  options: MapLayerOptions,
): Mesh | undefined {
  if (meshes.length === 0) return undefined;
  const result = meshes.length === 1 ? meshes[0] : Mesh.MergeMeshes(meshes, true, true);
  if (!result) return undefined;
  result.name = "waterways";
  result.material = createWaterSurfaceMaterial(result.getScene(), {
    name: "waterwayMaterial",
    width: options.meshWidth,
    height: options.meshDepth,
    metersPerUnit: options.metersPerUnit,
    skyReflection: options.skyReflection,
  });
  prepareWaterSurfaceMesh(result);
  result.isPickable = false;
  result.parent = parent;
  return result;
}
function createRoadMaterial(scene: Scene, name: string, visualStyle: RoadMaterialStyle): StandardMaterial {
  const material = new StandardMaterial(`${name}Material`, scene);
  switch (visualStyle) {
    case "unpaved": material.diffuseColor = new Color3(0.46, 0.39, 0.28); break;
    case "marked": material.diffuseColor = new Color3(0.72, 0.72, 0.68); break;
    case "pedestrian": material.diffuseColor = new Color3(0.38, 0.36, 0.33); break;
    case "ford": material.diffuseColor = new Color3(0.28, 0.32, 0.31); break;
    case "pavedShoulder": material.diffuseColor = new Color3(0.3, 0.29, 0.27); break;
    case "unpavedShoulder": material.diffuseColor = new Color3(0.4, 0.34, 0.25); break;
    case "bridgeDeck": material.diffuseColor = new Color3(0.16, 0.17, 0.17); break;
    default: material.diffuseColor = new Color3(0.2, 0.21, 0.2); break;
  }
  const looseSurface = visualStyle === "unpaved" || visualStyle === "unpavedShoulder";
  material.specularColor = looseSurface
    ? new Color3(0.008, 0.008, 0.006)
    : visualStyle === "ford"
      ? new Color3(0.08, 0.09, 0.085)
      : new Color3(0.018, 0.02, 0.018);
  material.specularPower = looseSurface ? 8 : visualStyle === "ford" ? 48 : 20;
  const texture = createRoadTexture(scene, `${name}Texture`, visualStyle, true);
  material.diffuseTexture = texture;
  if (looseSurface) {
    const relief = createRoadTexture(scene, `${name}Relief`, visualStyle, false);
    relief.level = 0.42;
    material.bumpTexture = relief;
  }
  return material;
}

/** Small deterministic texture: coarse aggregate for gravel, fine grain for asphalt. */
function createRoadTexture(
  scene: Scene,
  name: string,
  visualStyle: RoadMaterialStyle,
  gammaSpace: boolean,
): RawTexture {
  const pixels = new Uint8Array(ROAD_TEXTURE_SIZE * ROAD_TEXTURE_SIZE * 4);
  for (let y = 0; y < ROAD_TEXTURE_SIZE; y++) {
    for (let x = 0; x < ROAD_TEXTURE_SIZE; x++) {
      const offset = (y * ROAD_TEXTURE_SIZE + x) * 4;
      const fine = hashNoise(x, y);
      const coarse = hashNoise(Math.floor(x / 4), Math.floor(y / 4));
      const centerMark = visualStyle === "marked" &&
        Math.abs(y - (ROAD_TEXTURE_SIZE - 1) / 2) <= 1.25 &&
        x < ROAD_TEXTURE_SIZE * 0.58;
      const value = centerMark
        ? 235
        : visualStyle === "marked"
          ? 55 + Math.round((fine - 0.5) * 10)
          : visualStyle === "unpaved" || visualStyle === "unpavedShoulder"
            ? 150 + Math.round((fine - 0.5) * 70 + (coarse - 0.5) * 34)
            : visualStyle === "pedestrian"
              ? 185 + Math.round((fine - 0.5) * 18 + (coarse - 0.5) * 8)
              : visualStyle === "ford"
                ? 132 + Math.round((fine - 0.5) * 28 + (coarse - 0.5) * 12)
                : visualStyle === "pavedShoulder"
                  ? 148 + Math.round((fine - 0.5) * 28 + (coarse - 0.5) * 10)
                  : visualStyle === "bridgeDeck"
                    ? 118 + Math.round((fine - 0.5) * 16)
                    : 175 + Math.round((fine - 0.5) * 24);
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  const texture = RawTexture.CreateRGBATexture(
    pixels,
    ROAD_TEXTURE_SIZE,
    ROAD_TEXTURE_SIZE,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  texture.name = name;
  texture.gammaSpace = gammaSpace;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 12;
  return texture;
}

function hashNoise(x: number, y: number): number {
  let hash = Math.imul(x ^ 0x6d2b79f5, 0x1b873593) ^ Math.imul(y ^ 0x85ebca6b, 0xc2b2ae35);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return (hash >>> 0) / 0xffffffff;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}
