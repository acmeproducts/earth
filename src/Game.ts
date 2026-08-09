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
import { TerrainTiles, TerrainResult } from "./TerrainTiles";
import { createWaterPlane } from "./Water";
import { createTreeField } from "./TreeField";
import { createGrassField } from "./GrassField";
import { createFlowerField } from "./FlowerField";
import { createBushField } from "./BushField";
import { EXAMPLE_LOCATIONS } from "./Locations";
import { sceneToLonLat } from "./Geo";
import { OpenStreetMap } from "./OpenStreetMap";
import { landCoverColor, landCoverSurfaceColor, WorldCover } from "./WorldCover";
import { createTerrainMaterial } from "./TerrainMaterial";
import { SolarLighting } from "./SolarLighting";
import { FpsCounter } from "./FpsCounter";
import { VegetationFieldResult, VegetationRenderMode } from "./VegetationField";
import {
  DEFAULT_MODEL_RANGE_METERS,
  MAX_MODEL_RANGE_METERS,
  MIN_MODEL_RANGE_METERS,
  VegetationCategory,
  VegetationControls,
  VegetationModes,
} from "./VegetationControls";
import { DistantVista } from "./DistantVista";

type DebugTerrainLayer = "none" | "worldCover" | "openTopoMap";
const VEGETATION_LOD_UPDATE_MS = 100;
const MIN_FLY_SPEED = 0.05;
const MAX_FLY_SPEED = 10;
const FLY_SPEED_FACTOR_PER_NOTCH = 1.25;
const WHEEL_NOTCH_PIXELS = 100;
const GROUND_COVER_BLEND_METERS = 12;

interface TerrainMetadata {
  worldCoverColors?: Float32Array;
  surfaceColors?: Float32Array;
}

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
  private terrainData?: TerrainResult;
  // Slippy-map zoom numbers run opposite to ground coverage: 14 is one wider
  // level than 15 and gives the player a larger detailed area.
  private terrainZoom = 14;
  private readonly innerSize: number;
  private readonly renderScale: number;
  private debugTerrainLayer: DebugTerrainLayer = "none";
  private terrainRequestId = 0;
  private terrainLocationIndex = 0;
  private solarLighting?: SolarLighting;
  private readonly fpsCounter: FpsCounter;
  private readonly vegetationModes: VegetationModes;
  private vegetationControls?: VegetationControls;
  private vegetationLodDistanceMeters: number;
  private vegetationAmbientOcclusionEnabled: boolean;
  private lastVegetationLodUpdate = 0;
  private lastVegetationCameraPosition?: Vector3;
  private flyCamera?: UniversalCamera;
  private flySpeedOutput?: HTMLOutputElement;
  private distantVista?: DistantVista;

  private readonly handleFlySpeedWheel = (event: WheelEvent): void => {
    if (!this.flyCamera || event.deltaY === 0) return;

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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      antialias: true,
    });
    this.scene = new Scene(this.engine);
    const query = new URLSearchParams(window.location.search);
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
    this.vegetationModes = { trees: initialMode, grass: "impostors", bushes: "impostors" };
    const requestedDistance = query.get("vegetation-distance");
    const parsedDistance = Number(requestedDistance);
    this.vegetationLodDistanceMeters = requestedDistance !== null && Number.isFinite(parsedDistance)
      ? Math.max(MIN_MODEL_RANGE_METERS, Math.min(MAX_MODEL_RANGE_METERS, parsedDistance))
      : DEFAULT_MODEL_RANGE_METERS;
    this.vegetationAmbientOcclusionEnabled = !["0", "off", "false"].includes(
      query.get("vegetation-ao")?.toLowerCase() ?? "",
    );
  }

  async initialize(): Promise<void> {
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

    // Add Q/E for vertical movement
    const verticalSpeed = 0.2;
    this.scene.onKeyboardObservable.add((kbInfo) => {
      if (kbInfo.type === KeyboardEventTypes.KEYDOWN) {
        if (kbInfo.event.key === "q" || kbInfo.event.key === "Q") {
          camera.position.y -= verticalSpeed;
        }
        if (kbInfo.event.key === "e" || kbInfo.event.key === "E") {
          camera.position.y += verticalSpeed;
        }
      }
    });

    const location = EXAMPLE_LOCATIONS[this.terrainLocationIndex];
    this.solarLighting = new SolarLighting(
      this.scene,
      location.lat,
      location.lon,
    );

    // Load terrain at the active example location.
    await this.rebuildTerrain(this.terrainZoom);
    this.vegetationControls = new VegetationControls(
      this.vegetationModes,
      this.vegetationLodDistanceMeters,
      this.vegetationAmbientOcclusionEnabled,
      (category, mode) => this.setVegetationMode(category, mode),
      (distance) => this.setVegetationLodDistance(distance),
      (enabled) => this.setVegetationAmbientOcclusion(enabled),
    );
    this.setupDebugControls();
  }

  private async rebuildTerrain(zoom: number): Promise<void> {
    const requestId = ++this.terrainRequestId;
    const location = EXAMPLE_LOCATIONS[this.terrainLocationIndex];
    const terrainData = await TerrainTiles.fetchTileAtLocation(
      location.lat,
      location.lon,
      zoom,
      this.innerSize,
    );
    if (requestId !== this.terrainRequestId) return;
    if (!terrainData.bounds) throw new Error("Terrain bounds were not calculated.");

    const distantTerrainPromise = TerrainTiles.fetchTileAtLocation(
      location.lat,
      location.lon,
      Math.max(1, zoom - 3),
      this.innerSize,
    ).then(async (terrain) => {
      const lakeElevationSource = terrain.elevations.slice();
      if (!terrain.bounds) {
        return {
          terrain,
          landCover: undefined,
          mapWays: [],
          lakeElevationSource,
        };
      }
      const [distantLandCover, distantMapWays] = await Promise.all([
        WorldCover.fetch(terrain.bounds, 12).catch((error: unknown) => {
            console.warn("Distant WorldCover unavailable; vista vegetation was skipped.", error);
            return undefined;
          }),
        OpenStreetMap.fetch(terrain.bounds, 12).catch((error: unknown) => {
            console.warn("Distant OpenStreetMap unavailable; vista lakes were skipped.", error);
            return [];
          }),
      ]);
      distantLandCover?.constrainElevations(terrain);
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
    const lakeElevationSource = terrainData.elevations.slice();
    landCover?.constrainElevations(terrainData);

    // Download the heightmap to disk
    //TerrainTiles.downloadHeightmap(terrainData, 'oslo_heightmap.png');

    // Derive meters-per-unit from the real ground extent so
    // horizontal and vertical scales match 1:1 (absolute height).
    const meshWidth = 100; // scene units for the ground plane
    const groundWidth = terrainData.groundWidthMeters ?? 1000;
    const groundHeight = terrainData.groundHeightMeters ?? 1000;
    const metersPerUnit = groundWidth / meshWidth;
    const meshDepth = groundHeight / metersPerUnit; // may differ slightly from meshWidth due to latitude
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

    const treeField = await createTreeField(this.scene, terrainData, {
      meshWidth,
      meshDepth,
      metersPerUnit,
      seed: zoom,
      landCover,
      exclusionMask: roadExclusionMask,
      renderMode: this.vegetationModes.trees,
    });
    treeField.setAmbientOcclusionEnabled(this.vegetationAmbientOcclusionEnabled);
    if (requestId !== this.terrainRequestId) {
      terrain.dispose(false, true);
      treeField.root.dispose(false, false);
      return;
    }
    console.log(`Trees: ${treeField.count} WorldCover-placed instances`);

    const grassField = await createGrassField(this.scene, terrainData, {
      meshWidth,
      meshDepth,
      metersPerUnit,
      seed: zoom ^ 0x47524153,
      landCover,
      exclusionMask: roadExclusionMask,
      ambientOccluders: [treeField.instanceMatrices],
    });
    grassField.setAmbientOcclusionEnabled(this.vegetationAmbientOcclusionEnabled);
    if (requestId !== this.terrainRequestId) {
      terrain.dispose(false, true);
      treeField.root.dispose(false, false);
      grassField.root.dispose(false, false);
      return;
    }
    console.log(`Grass: ${grassField.count} WorldCover-placed instances`);

    const flowerField = await createFlowerField(this.scene, terrainData, {
      meshWidth,
      meshDepth,
      metersPerUnit,
      seed: zoom ^ 0x464c4f57,
      landCover,
      exclusionMask: roadExclusionMask,
      ambientOccluders: [treeField.instanceMatrices],
    });
    flowerField.setAmbientOcclusionEnabled(this.vegetationAmbientOcclusionEnabled);
    if (requestId !== this.terrainRequestId) {
      terrain.dispose(false, true);
      treeField.root.dispose(false, false);
      grassField.root.dispose(false, false);
      flowerField.root.dispose(false, false);
      return;
    }
    console.log(`Flowers: ${flowerField.count} simplex-placed grassland patches`);

    const bushField = await createBushField(this.scene, terrainData, {
      meshWidth,
      meshDepth,
      metersPerUnit,
      seed: zoom ^ 0x42555348,
      landCover,
      exclusionMask: roadExclusionMask,
      ambientOccluders: [treeField.instanceMatrices],
    });
    bushField.setAmbientOcclusionEnabled(this.vegetationAmbientOcclusionEnabled);
    if (requestId !== this.terrainRequestId) {
      terrain.dispose(false, true);
      treeField.root.dispose(false, false);
      grassField.root.dispose(false, false);
      flowerField.root.dispose(false, false);
      bushField.root.dispose(false, false);
      return;
    }
    console.log(`Bushes: ${bushField.count} WorldCover-placed instances`);

    const mapFeatures = OpenStreetMap.createLayer(this.scene, mapWays, terrainData, mapOptions);
    console.log(
      `OSM: ${mapFeatures.counts.buildings} buildings, ${mapFeatures.counts.roads} roads, ${mapFeatures.counts.water} water areas`,
    );

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
        })
      : undefined;
    distantVista?.setAmbientOcclusionEnabled(this.vegetationAmbientOcclusionEnabled);
    if (requestId !== this.terrainRequestId) {
      terrain.dispose(false, true);
      water.dispose(false, true);
      treeField.root.dispose(false, false);
      grassField.root.dispose(false, false);
      flowerField.root.dispose(false, false);
      bushField.root.dispose(false, false);
      mapFeatures.root.dispose(false, true);
      distantVista?.dispose();
      return;
    }
    this.terrain?.dispose(false, true);
    this.water?.dispose(false, true);
    // Impostor atlases are cached and shared by every rebuilt vegetation field.
    this.treeField?.root.dispose(false, false);
    this.grassField?.root.dispose(false, false);
    this.flowerField?.root.dispose(false, false);
    this.bushField?.root.dispose(false, false);
    this.mapFeatures?.dispose(false, true);
    this.distantVista?.dispose();
    this.terrain = terrain;
    this.water = water;
    this.treeField = treeField;
    this.grassField = grassField;
    this.flowerField = flowerField;
    this.bushField = bushField;
    this.mapFeatures = mapFeatures.root;
    this.distantVista = distantVista;
    this.terrainData = terrainData;
    this.updateVegetationLod(true);

    this.solarLighting?.setLocation(location.lat, location.lon);
    this.solarLighting?.setShadowCasters([
      terrain,
      ...mapFeatures.meshes,
    ]);
    await this.applyTerrainLayer(requestId);
  }

  /** Debug-only keyboard actions are isolated from camera input. */
  private setupDebugControls(): void {
    this.scene.onKeyboardObservable.add((kbInfo) => {
      if (kbInfo.type !== KeyboardEventTypes.KEYDOWN || (kbInfo.event as KeyboardEvent).repeat) return;

      if (kbInfo.event.key === "p" || kbInfo.event.key === "P") {
        void this.toggleDebugTerrainLayer("openTopoMap");
      } else if (kbInfo.event.key === "l" || kbInfo.event.key === "L") {
        void this.toggleDebugTerrainLayer("worldCover");
      } else if (kbInfo.event.key === "+" || kbInfo.event.code === "NumpadAdd") {
        void this.changeTerrainZoom(1);
      } else if (kbInfo.event.key === "-" || kbInfo.event.code === "NumpadSubtract") {
        void this.changeTerrainZoom(-1);
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
    if (category === "grass" || category === "bushes") mode = "impostors";
    this.vegetationModes[category] = mode;
    const field = category === "trees"
      ? this.treeField
      : category === "grass"
        ? this.grassField
        : this.bushField;
    field?.setRenderMode(mode);
    if (category === "grass") this.flowerField?.setRenderMode(mode);
    this.vegetationControls?.setMode(category, mode);
  }

  private setAllVegetationModes(mode: VegetationRenderMode): void {
    this.setVegetationMode("trees", mode);
    this.setVegetationMode("grass", mode);
    this.setVegetationMode("bushes", mode);
  }

  private setVegetationLodDistance(distanceMeters: number): void {
    this.vegetationLodDistanceMeters = distanceMeters;
    this.updateVegetationLod(true);
  }

  private setVegetationAmbientOcclusion(enabled: boolean): void {
    this.vegetationAmbientOcclusionEnabled = enabled;
    this.treeField?.setAmbientOcclusionEnabled(enabled);
    this.grassField?.setAmbientOcclusionEnabled(enabled);
    this.flowerField?.setAmbientOcclusionEnabled(enabled);
    this.bushField?.setAmbientOcclusionEnabled(enabled);
    this.distantVista?.setAmbientOcclusionEnabled(enabled);
    this.vegetationControls?.setAmbientOcclusionEnabled(enabled);
  }

  private updateVegetationLod(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastVegetationLodUpdate < VEGETATION_LOD_UPDATE_MS) return;
    const camera = this.scene.activeCamera;
    if (!camera) return;

    const position = camera.globalPosition;
    if (
      !force &&
      this.lastVegetationCameraPosition &&
      Vector3.DistanceSquared(position, this.lastVegetationCameraPosition) < 0.000001
    ) {
      return;
    }

    this.lastVegetationLodUpdate = now;
    this.lastVegetationCameraPosition = position.clone();
    this.treeField?.updateLod(position, this.vegetationLodDistanceMeters);
    this.grassField?.updateLod(position, this.vegetationLodDistanceMeters);
    this.flowerField?.updateLod(position, this.vegetationLodDistanceMeters);
    this.bushField?.updateLod(position, this.vegetationLodDistanceMeters);
  }

  private async changeTerrainLocation(locationIndex: number): Promise<void> {
    if (locationIndex === this.terrainLocationIndex) return;
    this.terrainLocationIndex = locationIndex;
    console.log(`Loading location ${locationIndex + 1}: ${EXAMPLE_LOCATIONS[locationIndex].name}`);
    await this.rebuildTerrain(this.terrainZoom);
  }

  private async toggleDebugTerrainLayer(layer: Exclude<DebugTerrainLayer, "none">): Promise<void> {
    this.debugTerrainLayer = this.debugTerrainLayer === layer ? "none" : layer;
    await this.applyTerrainLayer(this.terrainRequestId);
  }

  private async changeTerrainZoom(delta: number): Promise<void> {
    const nextZoom = Math.max(1, Math.min(15, this.terrainZoom + delta));
    if (nextZoom === this.terrainZoom) return;
    this.terrainZoom = nextZoom;
    await this.rebuildTerrain(nextZoom);
  }

  private async applyTerrainLayer(requestId: number): Promise<void> {
    if (!this.terrain || !this.terrainData) return;
    const terrain = this.terrain;

    if (this.debugTerrainLayer === "none") {
      this.applyDefaultTerrainMaterial(terrain);
      return;
    }

    if (this.debugTerrainLayer === "worldCover") {
      this.applyWorldCoverDebugMaterial(terrain);
      return;
    }

    const texture = await TerrainTiles.createOpenTopoMapTexture(this.scene, this.terrainData);
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
    terrain.material = material;
  }

  run(): void {
    this.engine.runRenderLoop(() => {
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
    this.flySpeedOutput?.remove();
    this.fpsCounter.dispose();
    this.vegetationControls?.dispose();
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
    const speed = this.flyCamera.speed.toFixed(2);
    this.flySpeedOutput.value = `Speed ${speed}`;
    this.flySpeedOutput.setAttribute("aria-label", `Fly speed ${speed}`);
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
    terrain: TerrainResult,
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
    const worldCoverColors = landCover && terrain.bounds
      ? new Float32Array((positions.length / 3) * 4)
      : undefined;
    const surfaceColors = landCover && terrain.bounds
      ? new Float32Array((positions.length / 3) * 4)
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

        const elevation =
          e00 * (1 - fx) * (1 - fy) +
          e10 * fx * (1 - fy) +
          e01 * (1 - fx) * fy +
          e11 * fx * fy;

        const vertexIndex = row * vPerRow + col;
        positions[vertexIndex * 3 + 1] = elevation / metersPerUnit;

        if (worldCoverColors && landCover && terrain.bounds) {
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
        }
      }
    }

    if (surfaceColors) {
      const metersPerVertex = Math.min(
        (terrain.groundWidthMeters ?? meshWidth * metersPerUnit) / subdivisions,
        (terrain.groundHeightMeters ?? meshDepth * metersPerUnit) / subdivisions,
      );
      smoothVertexColors(
        surfaceColors,
        vPerRow,
        Math.max(1, Math.round(GROUND_COVER_BLEND_METERS / metersPerVertex)),
      );
    }

    // Recompute normals for correct lighting after modifying heights
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, indices, normals);
    ground.updateVerticesData(VertexBuffer.PositionKind, positions);
    ground.updateVerticesData(VertexBuffer.NormalKind, normals);
    ground.metadata = { worldCoverColors, surfaceColors } satisfies TerrainMetadata;

    this.applyDefaultTerrainMaterial(ground);

    return ground;
  }

  private applyDefaultTerrainMaterial(terrain: Mesh): void {
    terrain.material?.dispose(true, true);
    const colors = (terrain.metadata as TerrainMetadata | null)?.surfaceColors;
    if (colors) {
      terrain.setVerticesData(VertexBuffer.ColorKind, colors);
      terrain.useVertexColors = true;
    } else {
      terrain.removeVerticesData(VertexBuffer.ColorKind);
    }
    terrain.material = createTerrainMaterial(this.scene, Boolean(colors));
  }

  private applyWorldCoverDebugMaterial(terrain: Mesh): void {
    const colors = (terrain.metadata as TerrainMetadata | null)?.worldCoverColors;
    if (!colors) {
      console.warn("WorldCover debug layer is unavailable for this terrain.");
      this.applyDefaultTerrainMaterial(terrain);
      return;
    }

    terrain.material?.dispose(true, true);
    terrain.setVerticesData(VertexBuffer.ColorKind, colors);
    terrain.useVertexColors = true;
    const material = new StandardMaterial("worldCoverDebugMaterial", this.scene);
    material.diffuseColor = Color3.White();
    material.specularColor = new Color3(0.1, 0.1, 0.1);
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

function queryInteger(
  query: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.round(queryNumber(query, name, fallback, minimum, maximum));
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
