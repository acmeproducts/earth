import {
  BaseTexture,
  Constants,
  Engine,
  RenderTargetTexture,
  Scene,
  SSRRenderingPipeline,
  UniversalCamera,
  Vector3,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Color4,
  Mesh,
  KeyboardEventTypes,
  VertexBuffer,
  VertexData,
  TransformNode,
} from "@babylonjs/core";
import type { TerrainData } from "./TerrainData";
import { TerrainElevationSource } from "./TerrainElevationSource";
import { createWaterPlane, disposeWaterPlane } from "./Water";
import { createTreeField } from "./TreeField";
import { createGrassField } from "./GrassField";
import { createFlowerField } from "./FlowerField";
import { createBushField } from "./BushField";
import { EXAMPLE_LOCATIONS } from "./Locations";
import {
  geographicFrameOffset,
  lonLatToScene,
  sampleElevation,
  sceneToLonLat,
  sinkSubmergedElevation,
  sinkSubmergedTerrain,
} from "./Geo";
import type { SceneGeographicFrame } from "./Geo";
import { OpenStreetMap } from "./OpenStreetMap";
import {
  landCoverColor,
  LandCoverClass,
  landCoverSurfaceColor,
  WorldCover,
} from "./WorldCover";
import { applyTerrainDepthBias, createTerrainMaterial } from "./TerrainMaterial";
import { configureWindSceneScale } from "./Wind";
import { varyGroundColor } from "./GroundVariation";
import { SolarLighting } from "./SolarLighting";
import { FpsCounter } from "./FpsCounter";
import { createFrameBudgetYielder } from "./FrameBudget";
import {
  VegetationFieldResult,
  VegetationLodDebugStats,
  VegetationRenderMode,
} from "./VegetationField";
import {
  DEFAULT_MODEL_RANGE_METERS,
  MAX_MODEL_RANGE_METERS,
  MIN_MODEL_RANGE_METERS,
  SceneControls,
} from "./SceneControls";
import {
  DEFAULT_WORLD_SEED,
  layerSeed,
  WORLD_GRID_LEVEL,
  worldTileArea,
  worldTileAtLocation,
  worldTileBounds,
  worldTileKey,
} from "./WorldGrid";
import type { WorldTileId } from "./WorldGrid";

type DebugTerrainLayer = "none" | "worldCover" | "openTopoMap";
type VegetationCategory = "trees" | "grass" | "bushes";
type VegetationModes = Record<VegetationCategory, VegetationRenderMode>;
type VegetationFieldKind = "treeField" | "grassField" | "flowerField" | "bushField";
const VEGETATION_FIELD_KINDS: readonly VegetationFieldKind[] = [
  "treeField",
  "grassField",
  "flowerField",
  "bushField",
];
const MIN_FLY_SPEED = 0.05;
const MAX_FLY_SPEED = 10;
const FLY_SPEED_FACTOR_PER_NOTCH = 1.25;
const WHEEL_NOTCH_PIXELS = 100;
const GROUND_COVER_BLEND_METERS = 12;
const PLAYER_HEIGHT_METERS = 1.8;
const PLAYER_RADIUS_METERS = 0.3;
const WALK_SPEED_METERS_PER_SECOND = 8;
const GRAVITY_METERS_PER_SECOND_SQUARED = 9.81;
const CAMERA_NEAR_CLIP_METERS = 0.1;
/** One world tile spans this many scene units in the stable frame. */
const TILE_MESH_WIDTH_UNITS = 25;
/** Terrain-only tiles stream out to this many rings around the camera. */
const TERRAIN_TILE_RADIUS = 6;
/** Vegetation and map features stream out to this many rings. */
const DETAIL_TILE_RADIUS = 2;
/** Scene units from the camera to the outer edge of the streamed terrain. */
const LOAD_HORIZON_UNITS = (TERRAIN_TILE_RADIUS + 0.5) * TILE_MESH_WIDTH_UNITS;
/** Share of that horizon the view stays clear before fog takes over. */
const FOG_START_FRACTION = 0.6;
/** Built tiles cool down for this long after leaving the radius before disposal. */
const TILE_COOLDOWN_MS = 30_000;
const DETAIL_COOLDOWN_MS = 10_000;
/** Terrain resolution for tiles beyond the detail rings. */
const FAR_TILE_SUBDIVISIONS = 32;
/**
 * Distant tree layers use wider spacing with raised occupancy, matching the
 * detail rings' trees per square meter at a quarter of the instance count.
 */
const FAR_TREE_SPACING_METERS = 5;
const FAR_TREE_OCCUPANCY = 1;
const FAR_TREE_EDGE_OCCUPANCY = 0.24;
const MAX_CONCURRENT_TILE_BUILDS = 3;
const TERRAIN_STREAMING_CHECK_INTERVAL_MS = 250;
/** Streamed layers dither in and out over this long instead of popping. */
const LAYER_FADE_DURATION_MS = 700;

type MovementMode = "fly" | "walk";

interface TerrainMetadata {
  worldCoverColors?: Float32Array;
  surfaceColors?: Float32Array;
}

/** One streamed world tile and every scene resource it owns. */
interface StreamedTile {
  id: WorldTileId;
  key: string;
  terrainData: TerrainData;
  terrain: Mesh;
  meshWidth: number;
  meshDepth: number;
  offsetX: number;
  offsetZ: number;
  /** The terrain mesh carries its native elevation resolution. */
  nativeTerrain: boolean;
  treeField?: VegetationFieldResult;
  grassField?: VegetationFieldResult;
  flowerField?: VegetationFieldResult;
  bushField?: VegetationFieldResult;
  mapFeatures?: TransformNode;
  /** Impostor-only tree layer carried by tiles outside the detail rings. */
  farTreeField?: VegetationFieldResult;
  /** Every detail layer is present. */
  detailed: boolean;
  lastNeededMilliseconds: number;
  detailLastNeededMilliseconds: number;
  /** Vegetation LOD already settled while the camera is out of reach. */
  lodResolved: boolean;
}

/** One running layer transition, advanced by the render loop. */
interface LayerFade {
  startMilliseconds: number;
  from: number;
  to: number;
  apply: (fade: number) => void;
  onComplete?: () => void;
  refreshShadows: boolean;
}

export type InitializationProgress = (step: string, progress: number) => void;

export class Game {
  private canvas: HTMLCanvasElement;
  private engine: Engine;
  private scene: Scene;
  private water?: Mesh;
  private readonly tiles = new Map<string, StreamedTile>();
  private readonly activeTileBuilds = new Set<string>();
  private readonly activeLayerFades: LayerFade[] = [];
  private streamingGeneration = 0;
  /** One shared budget keeps all concurrent tile builds inside a frame slice. */
  private readonly streamingYielder = createFrameBudgetYielder();
  private cameraTileKey?: string;
  private readonly gridLevel = WORLD_GRID_LEVEL;
  private readonly worldSeed: number;
  private readonly renderScale: number;
  private debugTerrainLayer: DebugTerrainLayer = "none";
  private lastTerrainStreamingCheckMilliseconds = 0;
  private terrainLocationIndex = 0;
  private solarLighting?: SolarLighting;
  private readonly fpsCounter: FpsCounter;
  private readonly vegetationModes: VegetationModes;
  private sceneControls?: SceneControls;
  private vegetationLodDistanceMeters: number;
  private readonly waterReflectionsEnabled: boolean;
  private flyCamera?: UniversalCamera;
  private flySpeedOutput?: HTMLOutputElement;
  private movementMode: MovementMode = "fly";
  private terrainCoordinateFrame?: SceneGeographicFrame;
  private terrainMetersPerUnit?: number;
  private readonly heldMovementKeys = new Set<string>();
  private verticalVelocityMetersPerSecond = 0;
  private lastVegetationLodDebugLogMilliseconds = 0;

  private readonly handleFlySpeedWheel = (event: WheelEvent): void => {
    if (!this.flyCamera || this.movementMode !== "fly" || event.deltaY === 0) return;

    event.preventDefault();
    const pixelsPerUnit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? Math.max(this.canvas.clientHeight, WHEEL_NOTCH_PIXELS)
        : 1;
    const wheelNotches = Math.max(
      -4,
      Math.min(4, (event.deltaY * pixelsPerUnit) / WHEEL_NOTCH_PIXELS),
    );
    this.flyCamera.speed = Math.max(
      MIN_FLY_SPEED,
      Math.min(
        MAX_FLY_SPEED,
        this.flyCamera.speed * Math.pow(FLY_SPEED_FACTOR_PER_NOTCH, -wheelNotches),
      ),
    );
    this.updateFlySpeedOutput();
  };

  private readonly handleWindowBlur = (): void => {
    this.heldMovementKeys.clear();
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      antialias: true,
    });
    this.engine.useReverseDepthBuffer = true;
    this.scene = new Scene(this.engine);
    // The app does not use hover picking. Skipping the implicit ray cast keeps
    // pointer movement from competing with rendering on slower CPUs.
    this.scene.skipPointerMovePicking = true;
    this.scene.collisionsEnabled = true;
    const query = new URLSearchParams(window.location.search);
    this.worldSeed = queryInteger(
      query,
      "seed",
      DEFAULT_WORLD_SEED,
      -2_147_483_648,
      2_147_483_647,
    );
    this.renderScale = queryNumber(query, "render-scale", 1, 0.25, 1);
    this.engine.setHardwareScalingLevel(1 / this.renderScale);
    this.fpsCounter = new FpsCounter(
      this.scene,
      query.has("performance-debug") || query.has("perf"),
      { renderScale: this.renderScale },
    );
    const requestedMode = query.get("vegetation");
    const initialMode: VegetationRenderMode = requestedMode === "models" || requestedMode === "impostors"
      ? requestedMode
      : "auto";
    this.vegetationModes = {
      trees: initialMode,
      grass: initialMode === "impostors" ? "impostors" : "auto",
      bushes: initialMode === "impostors" ? "impostors" : "auto",
    };
    const requestedDistance = query.get("vegetation-distance");
    const parsedDistance = Number(requestedDistance);
    this.vegetationLodDistanceMeters = requestedDistance !== null && Number.isFinite(parsedDistance)
      ? Math.max(MIN_MODEL_RANGE_METERS, Math.min(MAX_MODEL_RANGE_METERS, parsedDistance))
      : DEFAULT_MODEL_RANGE_METERS;
    this.waterReflectionsEnabled = !["0", "off", "false"].includes(
      query.get("reflections")?.toLowerCase() ?? "",
    );
  }

  async initialize(onProgress?: InitializationProgress): Promise<void> {
    await reportInitializationProgress(onProgress, "Preparing the scene", 3);
    // Set scene background
    this.scene.clearColor = new Color4(0.02, 0.02, 0.05, 1);

    // Create fly camera with WASD controls. The spawn stays well inside the
    // loaded window's central tile so startup does not immediately trigger a
    // terrain streaming pass.
    const camera = new UniversalCamera(
      "camera",
      new Vector3(0, 5, -6),
      this.scene,
    );
    camera.setTarget(Vector3.Zero());
    camera.attachControl(this.canvas, true);

    // WASD keys for movement (W=87, A=65, S=83, D=68)
    camera.keysUp = [87]; // W
    camera.keysDown = [83]; // S
    camera.keysLeft = [65]; // A
    camera.keysRight = [68]; // D

    // Movement speed
    camera.speed = 0.5;
    camera.angularSensibility = 1000;
    this.flyCamera = camera;
    this.setupFlySpeedControl();
    window.addEventListener("blur", this.handleWindowBlur);

    // Add Q/E for vertical movement
    const verticalSpeed = 0.2;
    this.scene.onKeyboardObservable.add((kbInfo) => {
      const key = kbInfo.event.key.toLowerCase();
      if (kbInfo.type === KeyboardEventTypes.KEYDOWN) {
        if (["w", "a", "s", "d"].includes(key)) this.heldMovementKeys.add(key);
        if (key === "g" && !(kbInfo.event as KeyboardEvent).repeat) this.toggleMovementMode();
        if (this.movementMode !== "fly") return;
        if (kbInfo.event.key === "q" || kbInfo.event.key === "Q") {
          camera.position.y -= verticalSpeed;
        }
        if (kbInfo.event.key === "e" || kbInfo.event.key === "E") {
          camera.position.y += verticalSpeed;
        }
      } else if (kbInfo.type === KeyboardEventTypes.KEYUP) {
        this.heldMovementKeys.delete(key);
      }
    });

    const location = EXAMPLE_LOCATIONS[this.terrainLocationIndex];
    this.solarLighting = new SolarLighting(
      this.scene,
      location.lat,
      location.lon,
    );
    if (this.waterReflectionsEnabled) this.enableWaterReflections(camera);

    // Load terrain at the active example location. Only the center tile
    // blocks the loading screen; the rest streams in from the render loop.
    await this.startWorld(location, onProgress);
    await reportInitializationProgress(onProgress, "Setting up controls", 98);
    this.sceneControls = new SceneControls(
      this.vegetationLodDistanceMeters,
      (distance) => this.setVegetationLodDistance(distance),
      (hours) => this.solarLighting?.setTimeOfDay(hours),
    );
    this.setupDebugControls();
    await reportInitializationProgress(onProgress, "Ready", 100);
  }

  /** Clears every streamed tile and starts a fresh world around a location. */
  private async startWorld(
    target: { lat: number; lon: number },
    onProgress?: InitializationProgress,
  ): Promise<void> {
    const generation = ++this.streamingGeneration;
    this.disposeAllTiles();
    this.terrainCoordinateFrame = undefined;
    this.terrainMetersPerUnit = undefined;
    this.solarLighting?.setLocation(target.lat, target.lon);
    await reportInitializationProgress(onProgress, "Loading terrain elevation", 10);
    const centerTile = worldTileAtLocation(target.lat, target.lon, this.gridLevel);
    // Only the center tile is awaited; every other tile streams in from the
    // render loop, nearest first.
    await this.streamTile(centerTile, true, generation, onProgress);
  }

  /** Brings one tile to the requested state (terrain, then optional detail). */
  private async streamTile(
    id: WorldTileId,
    wantDetail: boolean,
    generation: number,
    onProgress?: InitializationProgress,
  ): Promise<void> {
    const key = worldTileKey(id);
    if (this.activeTileBuilds.has(key)) return;
    this.activeTileBuilds.add(key);
    try {
      let record = this.tiles.get(key);
      if (!record || (wantDetail && !record.nativeTerrain)) {
        record = await this.buildTileTerrain(id, wantDetail, generation, onProgress);
      }
      if (!record) return;
      if (wantDetail && !record.detailed) {
        await this.buildTileDetail(record, generation, onProgress);
      } else if (!wantDetail && !record.farTreeField) {
        // Runs for undetailed tiles, and for detailed tiles the scheduler
        // queued ahead of a demotion (the stand-in commits hidden there).
        await this.buildFarTrees(record, generation);
      }
    } finally {
      this.activeTileBuilds.delete(key);
    }
  }

  private async buildTileTerrain(
    id: WorldTileId,
    native: boolean,
    generation: number,
    onProgress?: InitializationProgress,
  ): Promise<StreamedTile | undefined> {
    const key = worldTileKey(id);
    const area = worldTileArea(id, this.worldSeed);
    const terrainData = await TerrainElevationSource.fetchWorldArea(area);
    if (generation !== this.streamingGeneration) return undefined;
    await reportInitializationProgress(onProgress, "Loading land cover", 24);
    const landCover = await WorldCover.fetch(terrainData.bounds).catch((error: unknown) => {
      console.warn("ESA WorldCover unavailable; land-cover layers were skipped.", error);
      return undefined;
    });
    if (generation !== this.streamingGeneration) return undefined;
    landCover?.constrainElevations(terrainData);
    sinkSubmergedTerrain(terrainData);

    // The first tile of a world anchors the stable coordinate frame; every
    // later tile is projected into it so offsets stay exact while streaming.
    if (!this.terrainCoordinateFrame || !this.terrainMetersPerUnit) {
      const metersPerUnit = terrainData.groundWidthMeters / TILE_MESH_WIDTH_UNITS;
      this.terrainMetersPerUnit = metersPerUnit;
      this.terrainCoordinateFrame = {
        bounds: terrainData.bounds,
        meshWidth: TILE_MESH_WIDTH_UNITS,
        meshDepth: terrainData.groundHeightMeters / metersPerUnit,
      };
      // Gust wavelength is expressed in meters and must follow the stable
      // world frame's scale for every subsequently streamed tile.
      configureWindSceneScale(metersPerUnit);
      this.configureCameraCollisionBody();
      this.configureLoadHorizon();
      console.log(
        `World frame anchored at tile ${key} (1 unit = ${metersPerUnit.toFixed(1)}m)`,
      );
    }
    const frame = this.terrainCoordinateFrame;
    const metersPerUnit = this.terrainMetersPerUnit;
    const northWest = lonLatToScene(
      terrainData.bounds.lonWest,
      terrainData.bounds.latNorth,
      frame.bounds,
      frame.meshWidth,
      frame.meshDepth,
    );
    const southEast = lonLatToScene(
      terrainData.bounds.lonEast,
      terrainData.bounds.latSouth,
      frame.bounds,
      frame.meshWidth,
      frame.meshDepth,
    );
    const meshWidth = southEast.x - northWest.x;
    const meshDepth = northWest.z - southEast.z;
    const offset = geographicFrameOffset(frame, {
      bounds: terrainData.bounds,
      meshWidth,
      meshDepth,
    });

    const subdivisions = Math.max(
      1,
      native ? terrainData.width : Math.min(FAR_TILE_SUBDIVISIONS, terrainData.width),
    );
    const yieldControl = onProgress ? undefined : this.streamingYielder;
    await reportInitializationProgress(onProgress, "Building terrain mesh", 40);
    const terrain = await this.createTerrainMesh(`terrain ${key}`, terrainData, {
      meshWidth,
      meshDepth,
      subdivisions,
      metersPerUnit,
      landCover,
      yieldControl,
    });
    if (generation !== this.streamingGeneration) {
      terrain.dispose(false, true);
      return undefined;
    }
    setFrozenMeshOffset(terrain, offset.x, offset.z);
    terrain.checkCollisions = true;
    terrain.setEnabled(true);

    const previous = this.tiles.get(key);
    // Upgrading a streamed tile from the coarse terrain tier to native detail
    // replaces its record. Keep the already-visible distant tree stand-in
    // alive across that replacement; buildTileDetail will cross-fade it only
    // after the matching detailed tree field has committed.
    const carriedFarTreeField = previous?.farTreeField;
    if (previous) previous.farTreeField = undefined;
    const now = performance.now();
    const record: StreamedTile = {
      id: area.center,
      key,
      terrainData,
      terrain,
      meshWidth,
      meshDepth,
      offsetX: offset.x,
      offsetZ: offset.z,
      nativeTerrain: native,
      farTreeField: carriedFarTreeField,
      detailed: false,
      lastNeededMilliseconds: now,
      detailLastNeededMilliseconds: now,
      lodResolved: false,
    };
    this.tiles.set(key, record);
    if (previous) this.disposeTile(previous);
    if (this.debugTerrainLayer !== "none") await this.applyTerrainLayerToTile(record);
    this.ensurePlayerAboveGround();
    return record;
  }

  private async buildTileDetail(
    record: StreamedTile,
    generation: number,
    onProgress?: InitializationProgress,
  ): Promise<void> {
    const { terrainData } = record;
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!metersPerUnit) return;
    const yieldControl = onProgress ? undefined : this.streamingYielder;
    const startDisabled = !onProgress;
    await reportInitializationProgress(onProgress, "Loading map features", 50);
    // Rendered elevations were already sunk below the water; lakes need the
    // original heights, which the elevation cache reproduces without another
    // network round trip.
    const [mapWays, lakeElevationSource, landCover] = await Promise.all([
      OpenStreetMap.fetch(terrainData.bounds).catch((error: unknown) => {
        console.warn("OpenStreetMap unavailable; map features were skipped.", error);
        return [];
      }),
      TerrainElevationSource.fetchWorldArea(worldTileArea(record.id, this.worldSeed))
        .then((fresh) => fresh.elevations)
        .catch(() => undefined),
      WorldCover.fetch(terrainData.bounds).catch(() => undefined),
    ]);
    if (generation !== this.streamingGeneration) return;

    const mapOptions = {
      meshWidth: record.meshWidth,
      meshDepth: record.meshDepth,
      metersPerUnit,
      lakeElevationSource,
      startDisabled,
      ownerBounds: terrainData.bounds,
    };
    const exclusionMask = await OpenStreetMap.createRoadExclusionMask(
      mapWays,
      terrainData,
      mapOptions,
      yieldControl,
    );
    if (generation !== this.streamingGeneration) return;

    await reportInitializationProgress(onProgress, "Planting trees", 58);
    const treeField = await createTreeField(this.scene, terrainData, {
      meshWidth: record.meshWidth,
      meshDepth: record.meshDepth,
      metersPerUnit,
      seed: layerSeed(terrainData.generationSeed, "trees"),
      speciesSeed: layerSeed(this.worldSeed, "treeSpecies"),
      landCover,
      exclusionMask,
      renderMode: this.vegetationModes.trees,
      yieldControl,
      startDisabled,
    });
    if (!this.commitTileField(record, "treeField", treeField, generation)) return;

    await reportInitializationProgress(onProgress, "Growing grass", 66);
    const grassField = await createGrassField(this.scene, terrainData, {
      meshWidth: record.meshWidth,
      meshDepth: record.meshDepth,
      metersPerUnit,
      seed: layerSeed(terrainData.generationSeed, "grass"),
      landCover,
      exclusionMask,
      renderMode: this.vegetationModes.grass,
      yieldControl,
      startDisabled,
    });
    if (!this.commitTileField(record, "grassField", grassField, generation)) return;

    await reportInitializationProgress(onProgress, "Adding flowers", 72);
    const flowerField = await createFlowerField(this.scene, terrainData, {
      meshWidth: record.meshWidth,
      meshDepth: record.meshDepth,
      metersPerUnit,
      seed: layerSeed(terrainData.generationSeed, "flowers"),
      landCover,
      exclusionMask,
      renderMode: this.vegetationModes.grass,
      yieldControl,
      startDisabled,
    });
    if (!this.commitTileField(record, "flowerField", flowerField, generation)) return;

    await reportInitializationProgress(onProgress, "Adding bushes", 78);
    const bushField = await createBushField(this.scene, terrainData, {
      meshWidth: record.meshWidth,
      meshDepth: record.meshDepth,
      metersPerUnit,
      seed: layerSeed(terrainData.generationSeed, "bushes"),
      landCover,
      exclusionMask,
      renderMode: this.vegetationModes.bushes,
      yieldControl,
      startDisabled,
    });
    if (!this.commitTileField(record, "bushField", bushField, generation)) return;

    await reportInitializationProgress(onProgress, "Creating map features", 86);
    const mapFeatures = await OpenStreetMap.createLayer(
      this.scene,
      mapWays,
      terrainData,
      mapOptions,
      yieldControl,
    );
    if (generation !== this.streamingGeneration) {
      mapFeatures.root.dispose(false, true);
      return;
    }
    setTransformNodeOffset(mapFeatures.root, record.offsetX, record.offsetZ);
    mapFeatures.root.setEnabled(true);
    const mapRoot = mapFeatures.root;
    this.beginLayerFade(0, 1, (fade) => setMapLayerFade(mapRoot, fade), undefined, true);
    record.mapFeatures = mapFeatures.root;
    record.detailed = true;
    this.refreshShadowCasters();
    console.log(
      `Tile ${record.key}: ${treeField.count} trees, ${grassField.count} grass, ` +
      `${bushField.count} bushes, ${mapFeatures.counts.buildings} buildings, ` +
      `${mapFeatures.counts.roads} roads`,
    );
  }

  /**
   * Gives a tile outside the detail rings a cheap tree layer: lowest-LOD
   * impostors only, no models, no shadows, and no per-frame LOD work. Forests
   * then read all the way to the fog instead of ending at the detail ring.
   */
  private async buildFarTrees(record: StreamedTile, generation: number): Promise<void> {
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!metersPerUnit) return;
    const landCover = await WorldCover.fetch(record.terrainData.bounds).catch(() => undefined);
    if (generation !== this.streamingGeneration) return;
    const treeField = await createTreeField(this.scene, record.terrainData, {
      meshWidth: record.meshWidth,
      meshDepth: record.meshDepth,
      metersPerUnit,
      seed: layerSeed(record.terrainData.generationSeed, "trees"),
      speciesSeed: layerSeed(this.worldSeed, "treeSpecies"),
      landCover,
      spacingMeters: FAR_TREE_SPACING_METERS,
      occupancy: FAR_TREE_OCCUPANCY,
      edgeOccupancy: FAR_TREE_EDGE_OCCUPANCY,
      includeModels: false,
      forceLowestImpostorLod: true,
      renderMode: "impostors",
      yieldControl: this.streamingYielder,
      startDisabled: true,
    });
    if (generation !== this.streamingGeneration || record.farTreeField) {
      treeField.root.dispose(false, false);
      return;
    }
    // Far fields never swap LOD slots, so frustum culling is safe and drops
    // the tiles behind the camera from the draw list.
    for (const mesh of treeField.meshes) mesh.alwaysSelectAsActiveMesh = false;
    setTransformNodeOffset(treeField.root, record.offsetX, record.offsetZ);
    record.farTreeField = treeField;
    if (record.detailed) {
      // Pre-built for an upcoming demotion: stays hidden until the tile's full
      // detail cross-fades out.
      treeField.root.setEnabled(false);
    } else {
      treeField.root.setEnabled(true);
      this.fadeFieldIn(treeField);
    }
  }

  /** Starts one layer transition; the render loop advances and completes it. */
  private beginLayerFade(
    from: number,
    to: number,
    apply: (fade: number) => void,
    onComplete?: () => void,
    refreshShadows = false,
  ): void {
    apply(from);
    this.activeLayerFades.push({
      startMilliseconds: performance.now(),
      from,
      to,
      apply,
      onComplete,
      refreshShadows,
    });
  }

  private fadeFieldIn(field: VegetationFieldResult, refreshShadows = false): void {
    this.beginLayerFade(0, 1, (fade) => {
      if (!field.root.isDisposed()) field.setFade(fade);
    }, () => {
      // Leave one settled static frame after the temporary fade refreshes.
      this.solarLighting?.refreshShadows();
    }, refreshShadows);
  }

  private fadeFieldOutAndDispose(field: VegetationFieldResult, refreshShadows = false): void {
    this.beginLayerFade(1, 0, (fade) => {
      if (!field.root.isDisposed()) field.setFade(fade);
    }, () => field.root.dispose(false, false), refreshShadows);
  }

  private updateLayerFades(): void {
    if (this.activeLayerFades.length === 0) return;
    const now = performance.now();
    let refreshShadows = false;
    for (let index = this.activeLayerFades.length - 1; index >= 0; index--) {
      const fade = this.activeLayerFades[index];
      refreshShadows = refreshShadows || fade.refreshShadows;
      const progress = Math.min(1, (now - fade.startMilliseconds) / LAYER_FADE_DURATION_MS);
      const eased = progress * progress * (3 - 2 * progress);
      fade.apply(fade.from + (fade.to - fade.from) * eased);
      if (progress >= 1) {
        this.activeLayerFades.splice(index, 1);
        fade.onComplete?.();
      }
    }
    // The sun shadow map normally renders once because its casters are static.
    // During a streamed-layer cross-fade, however, the shadow depth shaders use
    // the same dither mask as the visible materials. Refresh temporarily so
    // shadows interpolate with the tile instead of jumping between snapshots.
    if (refreshShadows) this.solarLighting?.refreshShadows();
  }

  /** Commits one finished detail layer, or disposes it when the world moved on. */
  private commitTileField(
    record: StreamedTile,
    kind: VegetationFieldKind,
    field: VegetationFieldResult,
    generation: number,
  ): boolean {
    if (generation !== this.streamingGeneration) {
      field.root.dispose(false, false);
      return false;
    }
    setTransformNodeOffset(field.root, record.offsetX, record.offsetZ);
    field.root.setEnabled(true);
    record[kind] = field;
    record.lodResolved = false;
    this.fadeFieldIn(field, kind === "treeField");
    // The full tree layer cross-fades against the tile's distant stand-in.
    if (kind === "treeField" && record.farTreeField) {
      const farTrees = record.farTreeField;
      record.farTreeField = undefined;
      this.fadeFieldOutAndDispose(farTrees);
    }
    this.refreshShadowCasters();
    this.updateVegetationLod();
    return true;
  }

  /** Rebuilds the shadow render list from every live detail layer. */
  private refreshShadowCasters(): void {
    const casters: Mesh[] = [];
    for (const record of this.tiles.values()) {
      const fields = VEGETATION_FIELD_KINDS
        // Only trees cast vegetation shadows. Grass, flowers, and bushes stay
        // lit as receivers without adding noisy small geometry to the map.
        .filter((kind) => kind === "treeField")
        .map((kind) => record[kind])
        .filter((field): field is VegetationFieldResult => field !== undefined);
      if (fields.length === 0 && !record.mapFeatures) continue;
      casters.push(record.terrain);
      for (const field of fields) casters.push(...field.meshes);
      if (record.mapFeatures) {
        casters.push(...record.mapFeatures.getChildMeshes(false).filter(
          (mesh): mesh is Mesh => mesh instanceof Mesh,
        ));
      }
    }
    if (casters.length > 0) this.solarLighting?.setShadowCasters(casters);
  }

  /**
   * Screen-space reflections, aimed at the ocean.
   *
   * The pass runs over the whole frame but only touches pixels whose material
   * reported a reflectivity above the threshold. Terrain specular sits an
   * order of magnitude below it once the prepass linearises it, and the map
   * features are matte, so the water is the only surface that traces rays.
   *
   * Vegetation draws with custom shaders that write no prepass geometry. That
   * costs nothing here beyond trees reflecting as if they were painted on the
   * ground behind them, and it keeps the streamed instance fields out of an
   * extra geometry pass.
   */
  private enableWaterReflections(camera: UniversalCamera): void {
    const reflections = new SSRRenderingPipeline(
      "waterReflections",
      this.scene,
      [camera],
      false,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    if (!reflections.isSupported) {
      console.warn("Screen-space reflections are unsupported here; water stays flat.");
      reflections.dispose();
      return;
    }
    // Above the terrain's specular colour, below the water's reflectivity.
    reflections.reflectivityThreshold = 0.045;
    // Water is a weak reflector head-on and a mirror at grazing angles, which
    // is the whole reason the surface stops reading as a flat blue sheet.
    reflections.useFresnel = true;
    // A long stride with hit refinement covers the distance to the shoreline
    // for a fraction of the samples a per-pixel march would need.
    reflections.step = 12;
    reflections.maxSteps = 96;
    reflections.enableSmoothReflections = true;
    // Rays stop at the distance fog starts washing the scene out, which is as
    // far as a reflection can still be told apart from the haze.
    reflections.maxDistance = LOAD_HORIZON_UNITS * FOG_START_FRACTION;
    reflections.thickness = 0.4;
    // Waves tip some rays back down into the surface they just left; skipping
    // the first steps keeps those from returning the water's own colour.
    reflections.selfCollisionNumSkip = 3;
    // Blurring the reflection would mean gathering it in a separate
    // half-resolution texture, which smears the water's reflection across the
    // silhouettes in front of it and, because the vertical blur covers an even
    // number of rows, drops a black row off the top and bottom of an
    // odd-height frame. Scattering the rays themselves gives a rippled
    // surface's broken reflection with no neighbouring pixels involved, and
    // saves three full-screen passes.
    reflections.blurDispersionStrength = 0;
    reflections.roughnessFactor = 0.35;
    reflections.attenuateScreenBorders = true;
    reflections.attenuateFacingCamera = true;
    reflections.attenuateBackfaceReflection = true;
    // The prepass takes rendering off the back buffer, so the engine's own
    // anti-aliasing no longer applies to the scene.
    reflections.samples = 4;
    this.keepRenderTargetsOutOfPrePass();
  }

  /**
   * Babylon re-runs the prepass' "is anything still asking for this?" check at
   * the start of every render target draw, and answers it from the scene's
   * active camera. Inside a shadow map, a reflection probe or an impostor
   * capture that camera is not the one carrying the SSR post-processes, so the
   * check concludes nothing needs the prepass and switches it off until the
   * next time a material dirties it — which, with tiles streaming in and out,
   * leaves the reflections flickering on and off at random.
   *
   * None of those targets want prepass output anyway, and opting them out also
   * spares each one the multi-target attachments it was allocating.
   */
  private keepRenderTargetsOutOfPrePass(): void {
    const prePass = this.scene.prePassRenderer;
    if (!prePass) return;
    const exclude = (texture: BaseTexture): void => {
      if (!(texture instanceof RenderTargetTexture)) return;
      if (prePass.renderTargets.some((target) => target === texture)) return;
      texture.noPrePassRenderer = true;
    };
    for (const texture of this.scene.textures) exclude(texture);
    this.scene.onNewTextureAddedObservable.add(exclude);
  }

  /** Fog hides tiles popping in at the edge of the streamed radius. */
  private configureLoadHorizon(): void {
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogStart = LOAD_HORIZON_UNITS * FOG_START_FRACTION;
    this.scene.fogEnd = LOAD_HORIZON_UNITS * 0.95;
  }

  /** Keeps one large ocean plane centered on the camera's tile. */
  private recenterWater(center: WorldTileId): void {
    const frame = this.terrainCoordinateFrame;
    if (!frame) return;
    if (!this.water) {
      const sizeUnits = (2 * (TERRAIN_TILE_RADIUS + 1) + 1) * TILE_MESH_WIDTH_UNITS;
      this.water = createWaterPlane(this.scene, {
        width: sizeUnits,
        height: sizeUnits,
        metersPerUnit: this.terrainMetersPerUnit,
        skyReflection: this.solarLighting?.skyReflectionTexture,
      });
    }
    const bounds = worldTileBounds(center);
    const northWest = lonLatToScene(
      bounds.lonWest,
      bounds.latNorth,
      frame.bounds,
      frame.meshWidth,
      frame.meshDepth,
    );
    const southEast = lonLatToScene(
      bounds.lonEast,
      bounds.latSouth,
      frame.bounds,
      frame.meshWidth,
      frame.meshDepth,
    );
    setFrozenMeshOffset(
      this.water,
      (northWest.x + southEast.x) / 2,
      (northWest.z + southEast.z) / 2,
    );
  }

  private disposeTileDetail(record: StreamedTile): void {
    for (const kind of VEGETATION_FIELD_KINDS) {
      // Impostor atlases are cached per scene and intentionally outlive fields.
      record[kind]?.root.dispose(false, false);
      record[kind] = undefined;
    }
    record.mapFeatures?.dispose(false, true);
    record.mapFeatures = undefined;
    record.detailed = false;
  }

  private disposeTile(record: StreamedTile): void {
    this.disposeTileDetail(record);
    record.farTreeField?.root.dispose(false, false);
    record.farTreeField = undefined;
    record.terrain.dispose(false, true);
  }

  private disposeAllTiles(): void {
    this.activeLayerFades.length = 0;
    for (const record of this.tiles.values()) this.disposeTile(record);
    this.tiles.clear();
    this.activeTileBuilds.clear();
    if (this.water) disposeWaterPlane(this.water);
    this.water = undefined;
    this.cameraTileKey = undefined;
  }

  /**
   * Cross-fades a tile leaving the detail rings back to its distant stand-in:
   * the pre-built far trees dither in while every detail layer dithers out.
   */
  private demoteTileDetail(record: StreamedTile): void {
    const farTrees = record.farTreeField;
    if (farTrees && !farTrees.root.isDisposed()) {
      farTrees.setFade(0);
      farTrees.root.setEnabled(true);
      this.fadeFieldIn(farTrees);
    }
    for (const kind of VEGETATION_FIELD_KINDS) {
      const field = record[kind];
      if (!field) continue;
      record[kind] = undefined;
      this.fadeFieldOutAndDispose(field, kind === "treeField");
    }
    const mapFeatures = record.mapFeatures;
    if (mapFeatures) {
      record.mapFeatures = undefined;
      this.beginLayerFade(1, 0, (fade) => setMapLayerFade(mapFeatures, fade),
        () => mapFeatures.dispose(false, true), true);
    }
    record.detailed = false;
  }

  /** Disposes tiles that stayed outside the streamed radius past their cooldown. */
  private evictCooledTiles(now: number, center: WorldTileId): void {
    const scale = 2 ** center.level;
    let detailChanged = false;
    for (const record of [...this.tiles.values()]) {
      if (this.activeTileBuilds.has(record.key)) continue;
      const rawDx = Math.abs(record.id.x - center.x);
      const dx = Math.min(rawDx, scale - rawDx);
      const dy = Math.abs(record.id.y - center.y);
      const ring = Math.max(dx, dy);
      if (ring > TERRAIN_TILE_RADIUS + 1 &&
          now - record.lastNeededMilliseconds > TILE_COOLDOWN_MS) {
        this.tiles.delete(record.key);
        detailChanged = detailChanged || record.detailed;
        this.disposeTile(record);
      } else if (record.detailed && ring > DETAIL_TILE_RADIUS + 1 &&
          now - record.detailLastNeededMilliseconds > DETAIL_COOLDOWN_MS &&
          record.farTreeField) {
        // The streaming pass pre-builds the far stand-in; demotion waits for
        // it so the cross-fade never leaves the tile bare.
        this.demoteTileDetail(record);
        detailChanged = true;
      }
    }
    if (detailChanged) this.refreshShadowCasters();
  }

  /** Debug-only keyboard actions are isolated from camera input. */
  private setupDebugControls(): void {
    this.scene.onKeyboardObservable.add((kbInfo) => {
      if (kbInfo.type !== KeyboardEventTypes.KEYDOWN || (kbInfo.event as KeyboardEvent).repeat) return;

      if (kbInfo.event.key === "p" || kbInfo.event.key === "P") {
        void this.toggleDebugTerrainLayer("openTopoMap");
      } else if (kbInfo.event.key === "l" || kbInfo.event.key === "L") {
        void this.toggleDebugTerrainLayer("worldCover");
      } else if (kbInfo.event.key === "v" || kbInfo.event.key === "V") {
        const nextMode: VegetationRenderMode = this.vegetationModes.trees === "auto"
          ? "models"
          : this.vegetationModes.trees === "models"
            ? "impostors"
            : "auto";
        this.setAllVegetationModes(nextMode);
      } else if (kbInfo.event.key === "f" || kbInfo.event.key === "F") {
        this.fpsCounter.toggleExpanded();
      } else if (/^[1-9]$/.test(kbInfo.event.key)) {
        const locationIndex = Number(kbInfo.event.key) - 1;
        if (locationIndex < EXAMPLE_LOCATIONS.length) {
          void this.changeTerrainLocation(locationIndex);
        }
      }
    });
  }

  private setVegetationMode(category: VegetationCategory, mode: VegetationRenderMode): void {
    // Rendering every procedural clump as geometry is prohibitively costly;
    // Auto still provides real models in the immediate foreground.
    if ((category === "grass" || category === "bushes") && mode === "models") mode = "auto";
    this.vegetationModes[category] = mode;
    for (const record of this.tiles.values()) {
      const field = category === "trees"
        ? record.treeField
        : category === "grass"
          ? record.grassField
          : record.bushField;
      field?.setRenderMode(mode);
      if (category === "grass") record.flowerField?.setRenderMode(mode);
    }
    this.solarLighting?.refreshShadows();
  }

  private setAllVegetationModes(mode: VegetationRenderMode): void {
    this.setVegetationMode("trees", mode);
    this.setVegetationMode("grass", mode);
    this.setVegetationMode("bushes", mode);
  }

  private setVegetationLodDistance(distanceMeters: number): void {
    this.vegetationLodDistanceMeters = distanceMeters;
    this.updateVegetationLod();
  }

  private updateVegetationLod(): void {
    const camera = this.scene.activeCamera;
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!camera || !metersPerUnit) return;

    const cameraPosition = camera.globalPosition;
    const grassDistanceMeters = Math.min(this.vegetationLodDistanceMeters, 8);
    const bushDistanceMeters = Math.min(this.vegetationLodDistanceMeters, 16);
    // Fields sit at per-tile offsets in the stable frame; LOD runs in each
    // field's local space.
    const localCameraPosition = (field: VegetationFieldResult): Vector3 => {
      const position = cameraPosition.clone();
      position.x -= field.root.position.x;
      position.z -= field.root.position.z;
      return position;
    };
    let shadowsChanged = false;
    for (const record of this.tiles.values()) {
      if (!record.treeField && !record.grassField && !record.flowerField && !record.bushField) {
        continue;
      }
      // A freshly built field already renders as pure impostors, and instances
      // beyond the model range stay impostors. Only tiles the model range can
      // actually reach need per-frame LOD work; one final update settles a
      // tile when the camera leaves its reach.
      const reachUnits = (this.vegetationLodDistanceMeters + 40) / metersPerUnit +
        Math.hypot(record.meshWidth, record.meshDepth) / 2;
      const dx = cameraPosition.x - record.offsetX;
      const dz = cameraPosition.z - record.offsetZ;
      const withinReach = dx * dx + dz * dz <= reachUnits * reachUnits;
      if (!withinReach && record.lodResolved) continue;
      record.lodResolved = !withinReach;
      shadowsChanged = [
        record.treeField && record.treeField.updateLod(
          localCameraPosition(record.treeField),
          this.vegetationLodDistanceMeters,
        ),
        record.grassField && record.grassField.updateLod(
          localCameraPosition(record.grassField),
          grassDistanceMeters,
        ),
        record.flowerField && record.flowerField.updateLod(
          localCameraPosition(record.flowerField),
          grassDistanceMeters,
        ),
        record.bushField && record.bushField.updateLod(
          localCameraPosition(record.bushField),
          bushDistanceMeters,
        ),
      ].some(Boolean) || shadowsChanged;
    }
    if (shadowsChanged) this.solarLighting?.refreshShadows();
    this.logVegetationLodStats();
  }

  private logVegetationLodStats(): void {
    const now = performance.now();
    if (now - this.lastVegetationLodDebugLogMilliseconds < 2_000) return;
    this.lastVegetationLodDebugLogMilliseconds = now;
    const fields: VegetationFieldResult[] = [];
    for (const record of this.tiles.values()) {
      for (const kind of VEGETATION_FIELD_KINDS) {
        const field = record[kind];
        if (field) fields.push(field);
      }
    }
    const stats = fields.reduce<VegetationLodDebugStats>(
      (total, field) => addVegetationLodStats(total, field.consumeLodDebugStats()),
      emptyVegetationLodStats(),
    );
    if (stats.updates === 0) return;
    const averageProcessed = Math.round(stats.processedInstances / stats.updates);
    console.log(
      `[Vegetation LOD / 2s] total=${stats.totalInstances.toLocaleString()} ` +
      `grid-now=${stats.currentGridCandidates.toLocaleString()} ` +
      `transition-now=${stats.currentTransitionInstances.toLocaleString()} ` +
      `processed-avg=${averageProcessed.toLocaleString()}/update ` +
      `processed-peak=${stats.peakProcessedInstances.toLocaleString()} ` +
      `slot-crossings=${stats.membershipChanges.toLocaleString()} ` +
      `full-rebuilds=${stats.fullRebuilds}`,
    );
  }

  private async changeTerrainLocation(locationIndex: number): Promise<void> {
    if (locationIndex === this.terrainLocationIndex) return;
    this.terrainLocationIndex = locationIndex;
    console.log(`Loading location ${locationIndex + 1}: ${EXAMPLE_LOCATIONS[locationIndex].name}`);
    await this.startWorld(EXAMPLE_LOCATIONS[locationIndex]);
  }

  private updateTerrainStreaming(): void {
    const now = performance.now();
    if (now - this.lastTerrainStreamingCheckMilliseconds < TERRAIN_STREAMING_CHECK_INTERVAL_MS) {
      return;
    }
    this.lastTerrainStreamingCheckMilliseconds = now;

    const frame = this.terrainCoordinateFrame;
    const camera = this.flyCamera;
    if (!frame || !camera) return;
    const { lon, lat } = sceneToLonLat(
      camera.position.x,
      camera.position.z,
      frame.bounds,
      frame.meshWidth,
      frame.meshDepth,
    );
    const center = worldTileAtLocation(lat, lon, this.gridLevel);
    const centerKey = worldTileKey(center);
    if (centerKey !== this.cameraTileKey || !this.water) {
      this.cameraTileKey = centerKey;
      this.solarLighting?.setLocation(lat, lon);
      this.recenterWater(center);
    }

    const scale = 2 ** center.level;
    const generation = this.streamingGeneration;
    const work: Array<{ id: WorldTileId; detail: boolean; distanceSquared: number }> = [];
    for (let dy = -TERRAIN_TILE_RADIUS; dy <= TERRAIN_TILE_RADIUS; dy++) {
      const y = center.y + dy;
      if (y < 0 || y >= scale) continue;
      for (let dx = -TERRAIN_TILE_RADIUS; dx <= TERRAIN_TILE_RADIUS; dx++) {
        const id: WorldTileId = {
          level: center.level,
          x: ((center.x + dx) % scale + scale) % scale,
          y,
        };
        const key = worldTileKey(id);
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        const wantDetail = ring <= DETAIL_TILE_RADIUS;
        const record = this.tiles.get(key);
        if (record) {
          record.lastNeededMilliseconds = now;
          if (wantDetail) record.detailLastNeededMilliseconds = now;
        }
        if (this.activeTileBuilds.has(key)) continue;
        const needsTerrain = !record || (wantDetail && !record.nativeTerrain);
        const needsDetail = wantDetail && !(record?.detailed ?? false);
        // A detailed tile past its detail cooldown gets its far stand-in
        // pre-built (hidden) so the demotion can cross-fade seamlessly.
        const wantsDemotion = record !== undefined && record.detailed && !wantDetail &&
          now - record.detailLastNeededMilliseconds > DETAIL_COOLDOWN_MS;
        const needsFarTrees = !wantDetail && record !== undefined && !record.farTreeField &&
          (!record.detailed || wantsDemotion);
        if (needsTerrain || needsDetail || needsFarTrees) {
          work.push({ id, detail: wantDetail, distanceSquared: dx * dx + dy * dy });
        }
      }
    }
    work.sort((a, b) => a.distanceSquared - b.distanceSquared);
    for (const item of work) {
      if (this.activeTileBuilds.size >= MAX_CONCURRENT_TILE_BUILDS) break;
      void this.streamTile(item.id, item.detail, generation).catch((error: unknown) => {
        console.error(`Failed to stream tile ${worldTileKey(item.id)}.`, error);
      });
    }

    this.evictCooledTiles(now, center);
  }

  private async toggleDebugTerrainLayer(layer: Exclude<DebugTerrainLayer, "none">): Promise<void> {
    this.debugTerrainLayer = this.debugTerrainLayer === layer ? "none" : layer;
    await Promise.all(
      [...this.tiles.values()].map((record) => this.applyTerrainLayerToTile(record)),
    );
  }

  private async applyTerrainLayerToTile(record: StreamedTile): Promise<void> {
    if (this.debugTerrainLayer === "none") {
      this.applyDefaultTerrainMaterial(record.terrain, record.terrainData);
      return;
    }

    if (this.debugTerrainLayer === "worldCover") {
      this.applyWorldCoverDebugMaterial(record.terrain, record.terrainData);
      return;
    }

    const texture = await TerrainElevationSource.createOpenTopoMapTexture(this.scene, record.terrainData);
    if (this.debugTerrainLayer !== "openTopoMap" || record.terrain.isDisposed()) {
      texture.dispose();
      return;
    }

    record.terrain.material?.dispose(true, true);
    record.terrain.removeVerticesData(VertexBuffer.ColorKind);
    const material = new StandardMaterial("openTopoMapDebugMaterial", this.scene);
    material.diffuseTexture = texture;
    material.specularColor = new Color3(0.1, 0.1, 0.1);
    applyTerrainDepthBias(material);
    record.terrain.material = material;
  }

  run(): void {
    this.engine.runRenderLoop(() => {
      this.updateWalker();
      this.updateTerrainStreaming();
      this.updateLayerFades();
      this.updateVegetationLod();
      this.scene.render();
      this.fpsCounter.update(this.engine, this.scene);
    });
  }

  resize(): void {
    this.engine.resize();
  }

  dispose(): void {
    this.canvas.removeEventListener("wheel", this.handleFlySpeedWheel);
    window.removeEventListener("blur", this.handleWindowBlur);
    this.flySpeedOutput?.remove();
    this.fpsCounter.dispose();
    this.sceneControls?.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }

  private setupFlySpeedControl(): void {
    this.canvas.addEventListener("wheel", this.handleFlySpeedWheel, { passive: false });
    this.flySpeedOutput = document.createElement("output");
    this.flySpeedOutput.id = "flySpeed";
    document.body.appendChild(this.flySpeedOutput);
    this.updateFlySpeedOutput();
  }

  private updateFlySpeedOutput(): void {
    if (!this.flyCamera || !this.flySpeedOutput) return;
    if (this.movementMode === "walk") {
      this.flySpeedOutput.value = `Walk · ${WALK_SPEED_METERS_PER_SECOND.toFixed(1)} m/s · G: Fly`;
      this.flySpeedOutput.setAttribute("aria-label", "Walker mode. Press G for fly mode.");
      return;
    }

    const speed = this.flyCamera.speed.toFixed(2);
    this.flySpeedOutput.value = `Fly · Speed ${speed} · G: Walk`;
    this.flySpeedOutput.setAttribute("aria-label", `Fly mode. Speed ${speed}. Press G for walker mode.`);
  }

  private toggleMovementMode(): void {
    if (!this.flyCamera) return;

    this.movementMode = this.movementMode === "fly" ? "walk" : "fly";
    this.verticalVelocityMetersPerSecond = 0;
    this.flyCamera.cameraDirection.setAll(0);
    this.heldMovementKeys.clear();

    if (this.movementMode === "walk") {
      // Babylon's standard free-camera input follows the vertical look angle.
      // Walker movement is applied separately to remain parallel with the ground.
      this.flyCamera.keysUp = [];
      this.flyCamera.keysDown = [];
      this.flyCamera.keysLeft = [];
      this.flyCamera.keysRight = [];
      this.flyCamera.checkCollisions = true;
      this.configureCameraCollisionBody();
      this.ensurePlayerAboveGround();
    } else {
      this.flyCamera.keysUp = [87];
      this.flyCamera.keysDown = [83];
      this.flyCamera.keysLeft = [65];
      this.flyCamera.keysRight = [68];
      this.flyCamera.checkCollisions = false;
    }

    this.updateFlySpeedOutput();
  }

  private updateWalker(): void {
    const camera = this.flyCamera;
    const metersPerUnit = this.terrainMetersPerUnit;
    if (this.movementMode !== "walk" || !camera || !metersPerUnit) return;

    const deltaSeconds = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    const forward = Number(this.heldMovementKeys.has("w")) - Number(this.heldMovementKeys.has("s"));
    const right = Number(this.heldMovementKeys.has("d")) - Number(this.heldMovementKeys.has("a"));
    if (forward !== 0 || right !== 0) {
      const inputLength = Math.hypot(forward, right);
      const yaw = camera.rotation.y;
      const distance = WALK_SPEED_METERS_PER_SECOND * deltaSeconds / metersPerUnit;
      camera.position.x += (
        Math.sin(yaw) * forward + Math.cos(yaw) * right
      ) * distance / inputLength;
      camera.position.z += (
        Math.cos(yaw) * forward - Math.sin(yaw) * right
      ) * distance / inputLength;
    }

    const groundEyeHeight = this.getGroundEyeHeight(camera.position.x, camera.position.z);
    this.verticalVelocityMetersPerSecond -= GRAVITY_METERS_PER_SECOND_SQUARED * deltaSeconds;
    camera.position.y += (
      this.verticalVelocityMetersPerSecond * deltaSeconds / metersPerUnit
    );
    if (groundEyeHeight !== undefined && camera.position.y <= groundEyeHeight) {
      camera.position.y = groundEyeHeight;
      this.verticalVelocityMetersPerSecond = 0;
    }
  }

  private ensurePlayerAboveGround(): void {
    if (!this.flyCamera || this.movementMode !== "walk") return;
    const groundEyeHeight = this.getGroundEyeHeight(
      this.flyCamera.position.x,
      this.flyCamera.position.z,
    );
    if (groundEyeHeight !== undefined && this.flyCamera.position.y < groundEyeHeight) {
      this.flyCamera.position.y = groundEyeHeight;
      this.verticalVelocityMetersPerSecond = 0;
    }
  }

  /** Finds the streamed tile whose footprint contains a scene position. */
  private tileAtScenePosition(x: number, z: number): StreamedTile | undefined {
    const frame = this.terrainCoordinateFrame;
    if (!frame) return undefined;
    const { lon, lat } = sceneToLonLat(x, z, frame.bounds, frame.meshWidth, frame.meshDepth);
    return this.tiles.get(worldTileKey(worldTileAtLocation(lat, lon, this.gridLevel)));
  }

  private getGroundEyeHeight(x: number, z: number): number | undefined {
    const record = this.tileAtScenePosition(x, z);
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!record || !metersPerUnit) return undefined;
    const localX = x - record.offsetX;
    const localZ = z - record.offsetZ;

    // Use the highest point under the player's footprint so the 1.8 m body
    // cannot intersect a steep triangle beside its center point.
    const radius = PLAYER_RADIUS_METERS / metersPerUnit;
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [-radius, -radius],
      [radius, -radius],
      [-radius, radius],
      [radius, radius],
    ];
    let elevationMeters = -Infinity;
    for (const [offsetX, offsetZ] of offsets) {
      elevationMeters = Math.max(
        elevationMeters,
        sampleElevation(
          record.terrainData,
          localX + offsetX,
          localZ + offsetZ,
          record.meshWidth,
          record.meshDepth,
        ),
      );
    }
    return (elevationMeters + PLAYER_HEIGHT_METERS) / metersPerUnit;
  }

  private configureCameraCollisionBody(): void {
    const camera = this.flyCamera;
    const metersPerUnit = this.terrainMetersPerUnit;
    if (!camera || !metersPerUnit) return;
    camera.ellipsoid.set(
      PLAYER_RADIUS_METERS / metersPerUnit,
      PLAYER_HEIGHT_METERS / (2 * metersPerUnit),
      PLAYER_RADIUS_METERS / metersPerUnit,
    );
    // Babylon defaults minZ to one whole scene unit. One unit represents many
    // meters here, causing that near plane to slice through the ground below
    // a correctly positioned 1.8 m camera.
    camera.minZ = CAMERA_NEAR_CLIP_METERS / metersPerUnit;
    // FreeCamera positions its collision ellipsoid below the camera, placing
    // its bottom exactly one full player height below the eye point.
    camera.ellipsoidOffset.setAll(0);
  }

  /**
   * Creates a terrain mesh by setting vertex heights directly from
   * full-precision Float32 elevation data (no lossy image round-trip).
   * @param name - The name of the mesh
   * @param terrain - Processed terrain result with raw elevation data
   * @param options - Mesh dimensions and scale
   * @returns The created ground mesh
   */
  async createTerrainMesh(
    name: string,
    terrain: TerrainData,
    options: {
      meshWidth: number;
      meshDepth: number;
      subdivisions: number;
      metersPerUnit: number;
      landCover?: WorldCover;
      yieldControl?: () => Promise<void>;
    },
  ): Promise<Mesh> {
    const { meshWidth, meshDepth, subdivisions, metersPerUnit, landCover, yieldControl } = options;

    const ground = MeshBuilder.CreateGround(
      name,
      { width: meshWidth, height: meshDepth, subdivisions, updatable: true },
      this.scene,
    );
    // A cooperative build renders frames while the vertices are still flat;
    // the caller re-enables the mesh when it commits the finished terrain.
    if (yieldControl) ground.setEnabled(false);

    const positions = ground.getVerticesData(VertexBuffer.PositionKind)!;
    const indices = ground.getIndices()!;
    const { elevations, width: elevW, height: elevH } = terrain;
    const vPerRow = subdivisions + 1;
    const worldCoverColors = landCover
      ? new Float32Array((positions.length / 3) * 4)
      : undefined;
    const surfaceColors = landCover
      ? new Float32Array((positions.length / 3) * 4)
      : undefined;
    // Kept so the variation pass below can weight itself by surface type
    // without resampling the land cover raster.
    const coverClasses = landCover
      ? new Uint8Array(positions.length / 3)
      : undefined;

    for (let row = 0; row < vPerRow; row++) {
      for (let col = 0; col < vPerRow; col++) {
        // Map vertex grid position to elevation data coordinates
        const u = col / subdivisions;
        const v = row / subdivisions;
        const px = u * (elevW - 1);
        const py = v * (elevH - 1);

        // Bilinear interpolation
        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        const x1 = Math.min(x0 + 1, elevW - 1);
        const y1 = Math.min(y0 + 1, elevH - 1);
        const fx = px - x0;
        const fy = py - y0;

        const e00 = elevations[y0 * elevW + x0];
        const e10 = elevations[y0 * elevW + x1];
        const e01 = elevations[y1 * elevW + x0];
        const e11 = elevations[y1 * elevW + x1];

        const interpolatedElevation =
          e00 * (1 - fx) * (1 - fy) +
          e10 * fx * (1 - fy) +
          e01 * (1 - fx) * fy +
          e11 * fx * fy;
        // Interpolation across a shoreline can recreate shallow negative
        // heights after the source samples were sunk. Clamp the final vertex.
        const elevation = sinkSubmergedElevation(interpolatedElevation);

        const vertexIndex = row * vPerRow + col;
        positions[vertexIndex * 3 + 1] = elevation / metersPerUnit;

        if (worldCoverColors && landCover) {
          const { lon, lat } = sceneToLonLat(
            positions[vertexIndex * 3],
            positions[vertexIndex * 3 + 2],
            terrain.bounds,
            meshWidth,
            meshDepth,
          );
          const coverClass = landCover.sample(lon, lat);
          const [red, green, blue] = landCoverColor(coverClass);
          const [surfaceRed, surfaceGreen, surfaceBlue] = landCoverSurfaceColor(
            coverClass,
          );
          const colorIndex = vertexIndex * 4;
          worldCoverColors[colorIndex] = red;
          worldCoverColors[colorIndex + 1] = green;
          worldCoverColors[colorIndex + 2] = blue;
          worldCoverColors[colorIndex + 3] = 1;
          surfaceColors![colorIndex] = surfaceRed;
          surfaceColors![colorIndex + 1] = surfaceGreen;
          surfaceColors![colorIndex + 2] = surfaceBlue;
          surfaceColors![colorIndex + 3] = 1;
          coverClasses![vertexIndex] = coverClass;
        }
      }
      await yieldControl?.();
    }

    if (surfaceColors && coverClasses) {
      const metersPerVertex = Math.min(
        terrain.groundWidthMeters / subdivisions,
        terrain.groundHeightMeters / subdivisions,
      );
      await smoothVertexColors(
        surfaceColors,
        vPerRow,
        Math.max(1, Math.round(GROUND_COVER_BLEND_METERS / metersPerVertex)),
        yieldControl,
      );
      // Applied after the blend on purpose: smoothing exists to soften
      // land-cover class edges, and running it over the variation would erase
      // the finer bands this pass contributes.
      await applyGroundVariation(surfaceColors, coverClasses, positions, terrain, {
        meshWidth,
        meshDepth,
        metersPerVertex,
      }, yieldControl);
    }

    // Recompute normals for correct lighting after modifying heights
    await yieldControl?.();
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, indices, normals);
    // CreateGround leaves the bounding box flat at y = 0. Vertices carry
    // absolute elevation, so a mountain tile's geometry ends up hundreds of
    // units above bounds that still describe a flat plane, and the frustum
    // test, shadow frustum and collision broad phase all miss it. Updating the
    // extents alongside the positions keeps the bounds on the real surface.
    ground.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    ground.updateVerticesData(VertexBuffer.NormalKind, normals);
    ground.metadata = { worldCoverColors, surfaceColors } satisfies TerrainMetadata;
    ground.freezeWorldMatrix();

    this.applyDefaultTerrainMaterial(ground, terrain);

    return ground;
  }

  private applyDefaultTerrainMaterial(terrain: Mesh, data: TerrainData): void {
    terrain.material?.dispose(true, true);
    const colors = (terrain.metadata as TerrainMetadata | null)?.surfaceColors;
    if (colors) {
      terrain.setVerticesData(VertexBuffer.ColorKind, colors);
      terrain.useVertexColors = true;
    } else {
      terrain.removeVerticesData(VertexBuffer.ColorKind);
    }
    // The mesh spans the whole tile across one UV repeat, so the ground extent
    // is what turns the material's real-world detail scales into tiling.
    terrain.material = createTerrainMaterial(this.scene, {
      usesLandCoverTint: Boolean(colors),
      uvWidthMeters: data.groundWidthMeters,
      uvHeightMeters: data.groundHeightMeters,
    });
  }

  private applyWorldCoverDebugMaterial(terrain: Mesh, data: TerrainData): void {
    const colors = (terrain.metadata as TerrainMetadata | null)?.worldCoverColors;
    if (!colors) {
      console.warn("WorldCover debug layer is unavailable for this terrain.");
      this.applyDefaultTerrainMaterial(terrain, data);
      return;
    }

    terrain.material?.dispose(true, true);
    terrain.setVerticesData(VertexBuffer.ColorKind, colors);
    terrain.useVertexColors = true;
    const material = new StandardMaterial("worldCoverDebugMaterial", this.scene);
    material.diffuseColor = Color3.White();
    material.specularColor = new Color3(0.1, 0.1, 0.1);
    applyTerrainDepthBias(material);
    terrain.material = material;
  }
}

function queryNumber(
  query: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(query.get(name));
  return query.has(name) && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

/** Map features fade through per-mesh visibility; 1 restores the opaque path. */
function setMapLayerFade(root: TransformNode, fade: number): void {
  if (root.isDisposed()) return;
  for (const mesh of root.getChildMeshes(false)) mesh.visibility = fade;
}

function setFrozenMeshOffset(mesh: Mesh, x: number, z: number): void {
  const wasFrozen = mesh.isWorldMatrixFrozen;
  if (wasFrozen) mesh.unfreezeWorldMatrix();
  mesh.position.x = x;
  mesh.position.z = z;
  mesh.computeWorldMatrix(true);
  if (wasFrozen) mesh.freezeWorldMatrix();
}

function setTransformNodeOffset(root: TransformNode, x: number, z: number): void {
  const frozenChildren = root.getChildMeshes(false).filter((mesh) => mesh.isWorldMatrixFrozen);
  frozenChildren.forEach((mesh) => mesh.unfreezeWorldMatrix());
  root.position.x = x;
  root.position.z = z;
  root.computeWorldMatrix(true);
  root.getChildMeshes(false).forEach((mesh) => mesh.computeWorldMatrix(true));
  frozenChildren.forEach((mesh) => mesh.freezeWorldMatrix());
}

function emptyVegetationLodStats(): VegetationLodDebugStats {
  return {
    totalInstances: 0,
    updates: 0,
    processedInstances: 0,
    peakProcessedInstances: 0,
    currentGridCandidates: 0,
    currentTransitionInstances: 0,
    membershipChanges: 0,
    fullRebuilds: 0,
  };
}

function addVegetationLodStats(
  total: VegetationLodDebugStats,
  stats: VegetationLodDebugStats,
): VegetationLodDebugStats {
  total.totalInstances += stats.totalInstances;
  total.updates += stats.updates;
  total.processedInstances += stats.processedInstances;
  total.peakProcessedInstances += stats.peakProcessedInstances;
  total.currentGridCandidates += stats.currentGridCandidates;
  total.currentTransitionInstances += stats.currentTransitionInstances;
  total.membershipChanges += stats.membershipChanges;
  total.fullRebuilds += stats.fullRebuilds;
  return total;
}

function queryInteger(
  query: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.round(queryNumber(query, name, fallback, minimum, maximum));
}

async function reportInitializationProgress(
  onProgress: InitializationProgress | undefined,
  step: string,
  progress: number,
): Promise<void> {
  if (!onProgress) return;
  onProgress(step, progress);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Adds world-anchored ground variation on top of the blended land-cover colors.
 * The terrain textures repeat every few metres and must stay near-neutral, so
 * this pass owns the coarser variation that keeps mid and far ground from
 * reading as flat fields of one color per land-cover class.
 */
async function applyGroundVariation(
  colors: Float32Array,
  coverClasses: Uint8Array,
  positions: Float32Array | number[],
  terrain: TerrainData,
  options: { meshWidth: number; meshDepth: number; metersPerVertex: number },
  yieldControl?: () => Promise<void>,
): Promise<void> {
  for (let index = 0; index < coverClasses.length; index++) {
    const { lon, lat } = sceneToLonLat(
      positions[index * 3],
      positions[index * 3 + 2],
      terrain.bounds,
      options.meshWidth,
      options.meshDepth,
    );
    const target = index * 4;
    const [red, green, blue] = varyGroundColor(
      [colors[target], colors[target + 1], colors[target + 2]],
      lon,
      lat,
      coverClasses[index] as LandCoverClass,
      options.metersPerVertex,
    );
    colors[target] = red;
    colors[target + 1] = green;
    colors[target + 2] = blue;
    if ((index & 511) === 511) await yieldControl?.();
  }
}

async function smoothVertexColors(
  colors: Float32Array,
  rowSize: number,
  radius: number,
  yieldControl?: () => Promise<void>,
): Promise<void> {
  const horizontal = new Float32Array(colors.length);
  const vertexCount = colors.length / 4;

  for (let row = 0; row < rowSize; row++) {
    for (let column = 0; column < rowSize; column++) {
      const target = (row * rowSize + column) * 4;
      const start = Math.max(0, column - radius);
      const end = Math.min(rowSize - 1, column + radius);
      const count = end - start + 1;
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let sample = start; sample <= end; sample++) {
          sum += colors[(row * rowSize + sample) * 4 + channel];
        }
        horizontal[target + channel] = sum / count;
      }
      horizontal[target + 3] = 1;
    }
    await yieldControl?.();
  }

  for (let index = 0; index < vertexCount; index++) {
    const row = Math.floor(index / rowSize);
    const column = index % rowSize;
    const start = Math.max(0, row - radius);
    const end = Math.min(rowSize - 1, row + radius);
    const count = end - start + 1;
    for (let channel = 0; channel < 3; channel++) {
      let sum = 0;
      for (let sample = start; sample <= end; sample++) {
        sum += horizontal[(sample * rowSize + column) * 4 + channel];
      }
      colors[index * 4 + channel] = sum / count;
    }
    colors[index * 4 + 3] = 1;
    if (index % rowSize === rowSize - 1) await yieldControl?.();
  }
}
