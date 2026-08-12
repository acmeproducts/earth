import {
  Engine,
  Scene,
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
import { createWaterPlane } from "./Water";
import { createTreeField, DEFAULT_TREE_SPACING_METERS } from "./TreeField";
import { createGrassField } from "./GrassField";
import { createFlowerField } from "./FlowerField";
import { createBushField } from "./BushField";
import { EXAMPLE_LOCATIONS } from "./Locations";
import {
  sampleElevation,
  sceneToLonLat,
  sinkSubmergedElevation,
  sinkSubmergedTerrain,
} from "./Geo";
import { OpenStreetMap } from "./OpenStreetMap";
import {
  landCoverColor,
  LandCoverClass,
  landCoverSurfaceColor,
  WorldCover,
} from "./WorldCover";
import { applyTerrainDepthBias, createTerrainMaterial } from "./TerrainMaterial";
import { varyGroundColor } from "./GroundVariation";
import { SolarLighting } from "./SolarLighting";
import { FpsCounter } from "./FpsCounter";
import { VegetationFieldResult, VegetationRenderMode } from "./VegetationField";
import {
  DEFAULT_MODEL_RANGE_METERS,
  MAX_MODEL_RANGE_METERS,
  MIN_MODEL_RANGE_METERS,
  SceneControls,
} from "./SceneControls";
import { DistantVista } from "./DistantVista";
import {
  DEFAULT_WORLD_SEED,
  layerSeed,
  WORLD_GRID_LEVEL,
  worldTileAreaAtLocation,
} from "./WorldGrid";
import {
  chooseVistaVegetationSpacing,
  vegetationDensityScaleAcrossLocalBoundary,
} from "./VistaVegetation";

type DebugTerrainLayer = "none" | "worldCover" | "openTopoMap";
type VegetationCategory = "trees" | "grass" | "bushes";
type VegetationModes = Record<VegetationCategory, VegetationRenderMode>;
// OpenFreeMap starts including building footprints at zoom 13. The elevation
// can stay coarse while this independent vector zoom supplies vista geometry.
const DISTANT_OSM_ZOOM = 13;
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

type MovementMode = "fly" | "walk";

interface WalkableTerrain {
  data: TerrainData;
  width: number;
  depth: number;
  metersPerUnit: number;
}

interface TerrainMetadata {
  worldCoverColors?: Float32Array;
  surfaceColors?: Float32Array;
}

interface TerrainSceneResources {
  terrain?: Mesh;
  water?: Mesh;
  treeField?: VegetationFieldResult;
  grassField?: VegetationFieldResult;
  flowerField?: VegetationFieldResult;
  bushField?: VegetationFieldResult;
  mapFeatures?: TransformNode;
  distantVista?: DistantVista;
}

export type InitializationProgress = (step: string, progress: number) => void;

export class Game {
  private canvas: HTMLCanvasElement;
  private engine: Engine;
  private scene: Scene;
  private terrain?: Mesh;
  private water?: Mesh;
  private treeField?: VegetationFieldResult;
  private grassField?: VegetationFieldResult;
  private flowerField?: VegetationFieldResult;
  private bushField?: VegetationFieldResult;
  private mapFeatures?: TransformNode;
  private terrainData?: TerrainData;
  private readonly gridLevel = WORLD_GRID_LEVEL;
  private readonly worldSeed: number;
  private readonly innerSize: number;
  private readonly renderScale: number;
  private debugTerrainLayer: DebugTerrainLayer = "none";
  private terrainRequestId = 0;
  private terrainLocationIndex = 0;
  private solarLighting?: SolarLighting;
  private readonly fpsCounter: FpsCounter;
  private readonly vegetationModes: VegetationModes;
  private sceneControls?: SceneControls;
  private vegetationLodDistanceMeters: number;
  private vegetationAmbientOcclusionEnabled: boolean;
  private flyCamera?: UniversalCamera;
  private flySpeedOutput?: HTMLOutputElement;
  private movementMode: MovementMode = "fly";
  private walkableTerrain?: WalkableTerrain;
  private readonly heldMovementKeys = new Set<string>();
  private verticalVelocityMetersPerSecond = 0;
  private distantVista?: DistantVista;

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
    // The vista spans a much larger depth range than the local terrain. A
    // reversed depth buffer preserves precision at that distance and prevents
    // distant terrain, water, and mapped surfaces from collapsing onto the
    // same depth values on lower-precision GPUs.
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
    this.innerSize = queryInteger(query, "inner-size", 1, 1, 4);
    this.renderScale = queryNumber(query, "render-scale", 1, 0.25, 1);
    this.engine.setHardwareScalingLevel(1 / this.renderScale);
    this.fpsCounter = new FpsCounter(
      this.scene,
      query.has("performance-debug") || query.has("perf"),
      { renderScale: this.renderScale, innerSize: this.innerSize },
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
    this.vegetationAmbientOcclusionEnabled = !["0", "off", "false"].includes(
      query.get("vegetation-ao")?.toLowerCase() ?? "",
    );
  }

  async initialize(onProgress?: InitializationProgress): Promise<void> {
    await reportInitializationProgress(onProgress, "Preparing the scene", 3);
    // Set scene background
    this.scene.clearColor = new Color4(0.02, 0.02, 0.05, 1);

    // Create fly camera with WASD controls
    const camera = new UniversalCamera(
      "camera",
      new Vector3(0, 5, -15),
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

    // Load terrain at the active example location.
    await this.rebuildTerrain(onProgress);
    await reportInitializationProgress(onProgress, "Setting up controls", 98);
    this.sceneControls = new SceneControls(
      this.vegetationLodDistanceMeters,
      (distance) => this.setVegetationLodDistance(distance),
      (hours) => this.solarLighting?.setTimeOfDay(hours),
    );
    this.setupDebugControls();
    await reportInitializationProgress(onProgress, "Ready", 100);
  }

  private async rebuildTerrain(onProgress?: InitializationProgress): Promise<void> {
    const requestId = ++this.terrainRequestId;
    const location = EXAMPLE_LOCATIONS[this.terrainLocationIndex];
    await reportInitializationProgress(onProgress, "Loading terrain elevation", 8);
    const terrainArea = worldTileAreaAtLocation(
      location.lat,
      location.lon,
      this.innerSize,
      this.worldSeed,
      this.gridLevel,
    );
    const terrainData = await TerrainElevationSource.fetchWorldArea(terrainArea);
    if (requestId !== this.terrainRequestId) return;
    const localCenter = sceneToLonLat(
      0,
      0,
      terrainData.bounds,
      terrainData.groundWidthMeters,
      terrainData.groundHeightMeters,
    );

    await reportInitializationProgress(onProgress, "Loading maps and land cover", 18);
    const distantArea = worldTileAreaAtLocation(
      localCenter.lat,
      localCenter.lon,
      3,
      this.worldSeed,
      Math.max(1, this.gridLevel - 2),
    );
    const distantTerrainPromise = TerrainElevationSource.fetchWorldArea(distantArea).then(async (terrain) => {
      const lakeElevationSource = terrain.elevations.slice();
      const [distantLandCover, distantMapWays] = await Promise.all([
        WorldCover.fetch(terrain.bounds, 12).catch((error: unknown) => {
            console.warn("Distant WorldCover unavailable; vista vegetation was skipped.", error);
            return undefined;
          }),
        OpenStreetMap.fetch(terrain.bounds, DISTANT_OSM_ZOOM).catch((error: unknown) => {
            console.warn("Distant OpenStreetMap unavailable; vista map geometry was skipped.", error);
            return [];
          }),
      ]);
      distantLandCover?.constrainElevations(terrain);
      sinkSubmergedTerrain(terrain);
      return {
        terrain,
        landCover: distantLandCover,
        mapWays: distantMapWays,
        lakeElevationSource,
      };
    }).catch((error: unknown) => {
      console.warn("Distant terrain unavailable; the terrain ring was skipped.", error);
      return undefined;
    });
    const [landCover, mapWays, distantScene] = await Promise.all([
      WorldCover.fetch(terrainData.bounds).catch((error: unknown) => {
        console.warn("ESA WorldCover unavailable; land-cover layers were skipped.", error);
        return undefined;
      }),
      OpenStreetMap.fetch(terrainData.bounds).catch((error: unknown) => {
        console.warn("OpenStreetMap unavailable; map features were skipped.", error);
        return [];
      }),
      distantTerrainPromise,
    ]);
    if (requestId !== this.terrainRequestId) return;
    await reportInitializationProgress(onProgress, "Building terrain mesh", 34);
    const lakeElevationSource = terrainData.elevations.slice();
    landCover?.constrainElevations(terrainData);
    sinkSubmergedTerrain(terrainData);

    // Derive meters-per-unit from the real ground extent so
    // horizontal and vertical scales match 1:1 (absolute height).
    const meshWidth = 100; // scene units for the ground plane
    const groundWidth = terrainData.groundWidthMeters;
    const groundHeight = terrainData.groundHeightMeters;
    const metersPerUnit = groundWidth / meshWidth;
    const meshDepth = groundHeight / metersPerUnit; // may differ slightly from meshWidth due to latitude
    if (distantScene) {
      const vistaRadius = Math.min(
        distantScene.terrain.groundWidthMeters,
        distantScene.terrain.groundHeightMeters,
      ) / (2 * metersPerUnit);
      this.scene.fogMode = Scene.FOGMODE_LINEAR;
      this.scene.fogStart = vistaRadius * 0.65;
      this.scene.fogEnd = vistaRadius * 0.95;
    } else {
      this.scene.fogMode = Scene.FOGMODE_NONE;
    }
    const mapOptions = {
      meshWidth,
      meshDepth,
      metersPerUnit,
      lakeElevationSource,
      excludeBoundaryWater: true,
    };
    const roadExclusionMask = OpenStreetMap.createRoadExclusionMask(
      mapWays,
      terrainData,
      mapOptions,
    );

    console.log(
      `Ground extent: ${groundWidth.toFixed(0)}m × ${groundHeight.toFixed(0)}m → ${meshWidth} × ${meshDepth.toFixed(2)} units (1 unit = ${metersPerUnit.toFixed(1)}m)`,
    );
    console.log(
      `Elevation: ${terrainData.minElevation.toFixed(0)}m – ${terrainData.maxElevation.toFixed(0)}m`,
    );

    // Multiplier for mesh subdivisions relative to source image pixels.
    // 1 = one vertex per pixel, 0.5 = half resolution, 2 = double, etc.
    const subdivisionMultiplier = 1;
    const subdivisions = Math.max(
      1,
      Math.round(terrainData.width * subdivisionMultiplier),
    );

    console.log(
      `Terrain: ${terrainData.width}×${terrainData.height}px → ${subdivisions} subdivisions (×${subdivisionMultiplier})`,
    );

    const terrain = this.createTerrainMesh("terrain", terrainData, {
      meshWidth,
      meshDepth,
      subdivisions,
      metersPerUnit,
      landCover,
    });
    const resources: TerrainSceneResources = { terrain };

    const vistaVegetationSpacingMeters = distantScene
      ? chooseVistaVegetationSpacing(
          distantScene.terrain.groundWidthMeters,
          distantScene.terrain.groundHeightMeters,
        )
      : DEFAULT_TREE_SPACING_METERS;
    // Equalize actual trees per square meter at the seam, not merely the
    // occupancy percentage of two differently spaced candidate grids.
    const localBorderDensityScale = Math.pow(
      DEFAULT_TREE_SPACING_METERS / vistaVegetationSpacingMeters,
      2,
    );

    await reportInitializationProgress(onProgress, "Planting trees", 44);
    const treeField = await createTreeField(this.scene, terrainData, {
      meshWidth,
      meshDepth,
      metersPerUnit,
      seed: layerSeed(terrainData.generationSeed, "trees"),
      landCover,
      exclusionMask: roadExclusionMask,
      renderMode: this.vegetationModes.trees,
      densityScale: (worldX, worldZ) => vegetationDensityScaleAcrossLocalBoundary(
        worldX,
        worldZ,
        meshWidth / 2,
        meshDepth / 2,
        {
          innerScale: 0.88,
          borderScale: localBorderDensityScale,
          outerScale: localBorderDensityScale,
        },
      ),
    });
    resources.treeField = treeField;
    treeField.setAmbientOcclusionEnabled(this.vegetationAmbientOcclusionEnabled);
    if (this.discardStaleTerrainBuild(requestId, resources)) return;
    console.log(`Trees: ${treeField.count} WorldCover-placed instances`);

    await reportInitializationProgress(onProgress, "Growing grass", 55);
    const grassField = await createGrassField(this.scene, terrainData, {
      meshWidth,
      meshDepth,
      metersPerUnit,
      seed: layerSeed(terrainData.generationSeed, "grass"),
      landCover,
      exclusionMask: roadExclusionMask,
      ambientOccluders: [treeField.instanceMatrices],
      renderMode: this.vegetationModes.grass,
      densityScale: (worldX, worldZ) => vegetationDensityScaleAcrossLocalBoundary(
        worldX,
        worldZ,
        meshWidth / 2,
        meshDepth / 2,
        { innerScale: 1, borderScale: 0, outerScale: 0 },
      ),
    });
    resources.grassField = grassField;
    grassField.setAmbientOcclusionEnabled(this.vegetationAmbientOcclusionEnabled);
    if (this.discardStaleTerrainBuild(requestId, resources)) return;
    console.log(`Grass: ${grassField.count} WorldCover-placed instances`);

    await reportInitializationProgress(onProgress, "Adding flowers", 64);
    const flowerField = await createFlowerField(this.scene, terrainData, {
      meshWidth,
      meshDepth,
      metersPerUnit,
      seed: layerSeed(terrainData.generationSeed, "flowers"),
      landCover,
      exclusionMask: roadExclusionMask,
      ambientOccluders: [treeField.instanceMatrices],
      renderMode: this.vegetationModes.grass,
    });
    resources.flowerField = flowerField;
    flowerField.setAmbientOcclusionEnabled(this.vegetationAmbientOcclusionEnabled);
    if (this.discardStaleTerrainBuild(requestId, resources)) return;
    console.log(`Flowers: ${flowerField.count} simplex-placed grassland patches`);

    await reportInitializationProgress(onProgress, "Adding bushes", 72);
    const bushField = await createBushField(this.scene, terrainData, {
      meshWidth,
      meshDepth,
      metersPerUnit,
      seed: layerSeed(terrainData.generationSeed, "bushes"),
      landCover,
      exclusionMask: roadExclusionMask,
      ambientOccluders: [treeField.instanceMatrices],
      renderMode: this.vegetationModes.bushes,
    });
    resources.bushField = bushField;
    bushField.setAmbientOcclusionEnabled(this.vegetationAmbientOcclusionEnabled);
    if (this.discardStaleTerrainBuild(requestId, resources)) return;
    console.log(`Bushes: ${bushField.count} WorldCover-placed instances`);

    await reportInitializationProgress(onProgress, "Creating map features", 80);
    const mapFeatures = OpenStreetMap.createLayer(this.scene, mapWays, terrainData, mapOptions);
    resources.mapFeatures = mapFeatures.root;
    console.log(
      `OSM: ${mapFeatures.counts.buildings} buildings, ${mapFeatures.counts.roads} roads, ${mapFeatures.counts.water} water areas`,
    );

    await reportInitializationProgress(onProgress, "Creating water", 86);
    const water = createWaterPlane(this.scene, [
      terrain,
      ...treeField.meshes,
      ...grassField.meshes,
      ...flowerField.meshes,
      ...bushField.meshes,
      ...mapFeatures.meshes,
    ], {
      width: meshWidth,
      height: meshDepth,
    });
    resources.water = water;

    await reportInitializationProgress(onProgress, "Building the distant landscape", 91);
    const distantVista = distantScene
      ? await DistantVista.create(this.scene, distantScene.terrain, {
          localTerrain: terrainData,
          localMeshWidth: meshWidth,
          localMeshDepth: meshDepth,
          metersPerUnit,
          distantLandCover: distantScene.landCover,
          localLandCover: landCover,
          mapTiles: distantScene.mapWays,
          lakeElevationSource: distantScene.lakeElevationSource,
          waterMesh: water,
          vegetationSpacingMeters: vistaVegetationSpacingMeters,
        })
      : undefined;
    resources.distantVista = distantVista;
    distantVista?.setAmbientOcclusionEnabled(this.vegetationAmbientOcclusionEnabled);
    if (this.discardStaleTerrainBuild(requestId, resources)) return;
    disposeTerrainSceneResources({
      terrain: this.terrain,
      water: this.water,
      treeField: this.treeField,
      grassField: this.grassField,
      flowerField: this.flowerField,
      bushField: this.bushField,
      mapFeatures: this.mapFeatures,
      distantVista: this.distantVista,
    });
    this.terrain = terrain;
    terrain.checkCollisions = true;
    this.water = water;
    this.treeField = treeField;
    this.grassField = grassField;
    this.flowerField = flowerField;
    this.bushField = bushField;
    this.mapFeatures = mapFeatures.root;
    this.distantVista = distantVista;
    this.terrainData = terrainData;
    this.walkableTerrain = {
      data: terrainData,
      width: meshWidth,
      depth: meshDepth,
      metersPerUnit,
    };
    this.configureCameraCollisionBody();
    this.ensurePlayerAboveGround();
    this.updateVegetationLod();

    this.solarLighting?.setLocation(location.lat, location.lon);
    this.solarLighting?.setShadowCasters([
      terrain,
      ...mapFeatures.meshes,
    ]);
    await reportInitializationProgress(onProgress, "Finalizing terrain appearance", 96);
    await this.applyTerrainLayer(requestId);
  }

  private discardStaleTerrainBuild(
    requestId: number,
    resources: TerrainSceneResources,
  ): boolean {
    if (requestId === this.terrainRequestId) return false;
    disposeTerrainSceneResources(resources);
    return true;
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
      } else if (kbInfo.event.key === "o" || kbInfo.event.key === "O") {
        this.setVegetationAmbientOcclusion(!this.vegetationAmbientOcclusionEnabled);
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
    const field = category === "trees"
      ? this.treeField
      : category === "grass"
        ? this.grassField
        : this.bushField;
    field?.setRenderMode(mode);
    if (category === "grass") this.flowerField?.setRenderMode(mode);
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

  private setVegetationAmbientOcclusion(enabled: boolean): void {
    this.vegetationAmbientOcclusionEnabled = enabled;
    this.treeField?.setAmbientOcclusionEnabled(enabled);
    this.grassField?.setAmbientOcclusionEnabled(enabled);
    this.flowerField?.setAmbientOcclusionEnabled(enabled);
    this.bushField?.setAmbientOcclusionEnabled(enabled);
    this.distantVista?.setAmbientOcclusionEnabled(enabled);
  }

  private updateVegetationLod(): void {
    const camera = this.scene.activeCamera;
    if (!camera) return;

    const position = camera.globalPosition;
    this.treeField?.updateLod(position, this.vegetationLodDistanceMeters);
    this.grassField?.updateLod(position, Math.min(this.vegetationLodDistanceMeters, 8));
    this.flowerField?.updateLod(position, Math.min(this.vegetationLodDistanceMeters, 8));
    this.bushField?.updateLod(position, Math.min(this.vegetationLodDistanceMeters, 16));
  }

  private async changeTerrainLocation(locationIndex: number): Promise<void> {
    if (locationIndex === this.terrainLocationIndex) return;
    this.terrainLocationIndex = locationIndex;
    console.log(`Loading location ${locationIndex + 1}: ${EXAMPLE_LOCATIONS[locationIndex].name}`);
    await this.rebuildTerrain();
  }

  private async toggleDebugTerrainLayer(layer: Exclude<DebugTerrainLayer, "none">): Promise<void> {
    this.debugTerrainLayer = this.debugTerrainLayer === layer ? "none" : layer;
    await this.applyTerrainLayer(this.terrainRequestId);
  }

  private async applyTerrainLayer(requestId: number): Promise<void> {
    if (!this.terrain || !this.terrainData) return;
    const terrain = this.terrain;

    if (this.debugTerrainLayer === "none") {
      this.applyDefaultTerrainMaterial(terrain, this.terrainData);
      return;
    }

    if (this.debugTerrainLayer === "worldCover") {
      this.applyWorldCoverDebugMaterial(terrain, this.terrainData);
      return;
    }

    const texture = await TerrainElevationSource.createOpenTopoMapTexture(this.scene, this.terrainData);
    if (
      this.debugTerrainLayer !== "openTopoMap" ||
      requestId !== this.terrainRequestId ||
      terrain !== this.terrain
    ) {
      texture.dispose();
      return;
    }

    terrain.material?.dispose(true, true);
    terrain.removeVerticesData(VertexBuffer.ColorKind);
    const material = new StandardMaterial("openTopoMapDebugMaterial", this.scene);
    material.diffuseTexture = texture;
    material.specularColor = new Color3(0.1, 0.1, 0.1);
    applyTerrainDepthBias(material);
    terrain.material = material;
  }

  run(): void {
    this.engine.runRenderLoop(() => {
      this.updateWalker();
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
    const terrain = this.walkableTerrain;
    if (this.movementMode !== "walk" || !camera || !terrain) return;

    const deltaSeconds = Math.min(this.engine.getDeltaTime() / 1000, 0.05);
    const forward = Number(this.heldMovementKeys.has("w")) - Number(this.heldMovementKeys.has("s"));
    const right = Number(this.heldMovementKeys.has("d")) - Number(this.heldMovementKeys.has("a"));
    if (forward !== 0 || right !== 0) {
      const inputLength = Math.hypot(forward, right);
      const yaw = camera.rotation.y;
      const distance = WALK_SPEED_METERS_PER_SECOND * deltaSeconds / terrain.metersPerUnit;
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
      this.verticalVelocityMetersPerSecond * deltaSeconds / terrain.metersPerUnit
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

  private getGroundEyeHeight(x: number, z: number): number | undefined {
    const terrain = this.walkableTerrain;
    if (!terrain) return undefined;
    if (Math.abs(x) > terrain.width / 2 || Math.abs(z) > terrain.depth / 2) return undefined;

    // Use the highest point under the player's footprint so the 1.8 m body
    // cannot intersect a steep triangle beside its center point.
    const radius = PLAYER_RADIUS_METERS / terrain.metersPerUnit;
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
          terrain.data,
          x + offsetX,
          z + offsetZ,
          terrain.width,
          terrain.depth,
        ),
      );
    }
    return (elevationMeters + PLAYER_HEIGHT_METERS) / terrain.metersPerUnit;
  }

  private configureCameraCollisionBody(): void {
    const camera = this.flyCamera;
    const terrain = this.walkableTerrain;
    if (!camera || !terrain) return;
    camera.ellipsoid.set(
      PLAYER_RADIUS_METERS / terrain.metersPerUnit,
      PLAYER_HEIGHT_METERS / (2 * terrain.metersPerUnit),
      PLAYER_RADIUS_METERS / terrain.metersPerUnit,
    );
    // Babylon defaults minZ to one whole scene unit. One unit represents many
    // meters here, causing that near plane to slice through the ground below
    // a correctly positioned 1.8 m camera.
    camera.minZ = CAMERA_NEAR_CLIP_METERS / terrain.metersPerUnit;
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
  createTerrainMesh(
    name: string,
    terrain: TerrainData,
    options: {
      meshWidth: number;
      meshDepth: number;
      subdivisions: number;
      metersPerUnit: number;
      landCover?: WorldCover;
    },
  ): Mesh {
    const { meshWidth, meshDepth, subdivisions, metersPerUnit, landCover } = options;

    const ground = MeshBuilder.CreateGround(
      name,
      { width: meshWidth, height: meshDepth, subdivisions, updatable: true },
      this.scene,
    );

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
    }

    if (surfaceColors && coverClasses) {
      const metersPerVertex = Math.min(
        terrain.groundWidthMeters / subdivisions,
        terrain.groundHeightMeters / subdivisions,
      );
      smoothVertexColors(
        surfaceColors,
        vPerRow,
        Math.max(1, Math.round(GROUND_COVER_BLEND_METERS / metersPerVertex)),
      );
      // Applied after the blend on purpose: smoothing exists to soften
      // land-cover class edges, and running it over the variation would erase
      // the finer bands this pass contributes.
      applyGroundVariation(surfaceColors, coverClasses, positions, terrain, {
        meshWidth,
        meshDepth,
        metersPerVertex,
      });
    }

    // Recompute normals for correct lighting after modifying heights
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, indices, normals);
    ground.updateVerticesData(VertexBuffer.PositionKind, positions);
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

function disposeTerrainSceneResources(resources: TerrainSceneResources): void {
  resources.terrain?.dispose(false, true);
  resources.water?.dispose(false, true);
  // Impostor atlases are cached per scene and intentionally outlive rebuilt fields.
  resources.treeField?.root.dispose(false, false);
  resources.grassField?.root.dispose(false, false);
  resources.flowerField?.root.dispose(false, false);
  resources.bushField?.root.dispose(false, false);
  resources.mapFeatures?.dispose(false, true);
  resources.distantVista?.dispose();
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
function applyGroundVariation(
  colors: Float32Array,
  coverClasses: Uint8Array,
  positions: Float32Array | number[],
  terrain: TerrainData,
  options: { meshWidth: number; meshDepth: number; metersPerVertex: number },
): void {
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
  }
}

function smoothVertexColors(colors: Float32Array, rowSize: number, radius: number): void {
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
  }
}
