import {
  Engine,
  Scene,
  UniversalCamera,
  Vector3,
  HemisphericLight,
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
import { EXAMPLE_LOCATIONS } from "./Locations";
import { sceneToLonLat } from "./Geo";
import { OpenStreetMap } from "./OpenStreetMap";
import { landCoverColor, WorldCover } from "./WorldCover";
import { createTerrainMaterial } from "./TerrainMaterial";

type DebugTerrainLayer = "none" | "worldCover" | "openTopoMap";

interface TerrainMetadata {
  worldCoverColors?: Float32Array;
}

export class Game {
  private canvas: HTMLCanvasElement;
  private engine: Engine;
  private scene: Scene;
  private terrain?: Mesh;
  private water?: Mesh;
  private treeField?: TransformNode;
  private mapFeatures?: TransformNode;
  private terrainData?: TerrainResult;
  private terrainZoom = 15;
  private debugTerrainLayer: DebugTerrainLayer = "none";
  private terrainRequestId = 0;
  private terrainLocationIndex = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.engine = new Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      antialias: true,
    });
    this.scene = new Scene(this.engine);
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

    // Create lights
    const hemisphericLight = new HemisphericLight(
      "hemisphericLight",
      new Vector3(1, 1, 0),
      this.scene,
    );
    hemisphericLight.intensity = 1.0;
    hemisphericLight.groundColor = new Color3(0.1, 0.1, 0.2);

    // Oslo coordinates: 59.91°N, 10.75°E
    await this.rebuildTerrain(this.terrainZoom);
    this.setupDebugControls();
  }

  private async rebuildTerrain(zoom: number): Promise<void> {
    const requestId = ++this.terrainRequestId;
    const location = EXAMPLE_LOCATIONS[this.terrainLocationIndex];
    const terrainData = await TerrainTiles.fetchTileAtLocation(
      location.lat,
      location.lon,
      zoom,
    );
    if (requestId !== this.terrainRequestId) return;
    if (!terrainData.bounds) throw new Error("Terrain bounds were not calculated.");

    const [landCover, mapWays] = await Promise.all([
      WorldCover.fetch(terrainData.bounds).catch((error: unknown) => {
        console.warn("ESA WorldCover unavailable; land-cover layers were skipped.", error);
        return undefined;
      }),
      OpenStreetMap.fetch(terrainData.bounds).catch((error: unknown) => {
        console.warn("OpenStreetMap unavailable; map features were skipped.", error);
        return [];
      }),
    ]);
    if (requestId !== this.terrainRequestId) return;
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

    const treeField = createTreeField(this.scene, terrainData, {
      meshWidth,
      meshDepth,
      metersPerUnit,
      seed: zoom,
      landCover,
    });
    console.log(`Trees: ${treeField.count} WorldCover-placed instances`);

    const mapFeatures = OpenStreetMap.createLayer(this.scene, mapWays, terrainData, {
      meshWidth,
      meshDepth,
      metersPerUnit,
    });
    console.log(
      `OSM: ${mapFeatures.counts.buildings} buildings, ${mapFeatures.counts.roads} roads, ${mapFeatures.counts.water} water areas`,
    );

    const water = createWaterPlane(this.scene, [terrain, ...treeField.meshes, ...mapFeatures.meshes], {
      width: meshWidth,
      height: meshDepth,
    });

    this.terrain?.dispose(false, true);
    this.water?.dispose(false, true);
    this.treeField?.dispose(false, true);
    this.mapFeatures?.dispose(false, true);
    this.terrain = terrain;
    this.water = water;
    this.treeField = treeField.root;
    this.mapFeatures = mapFeatures.root;
    this.terrainData = terrainData;

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
      } else if (/^[1-9]$/.test(kbInfo.event.key)) {
        const locationIndex = Number(kbInfo.event.key) - 1;
        if (locationIndex < EXAMPLE_LOCATIONS.length) {
          void this.changeTerrainLocation(locationIndex);
        }
      }
    });
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
      this.scene.render();
    });
  }

  resize(): void {
    this.engine.resize();
  }

  dispose(): void {
    this.scene.dispose();
    this.engine.dispose();
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
          const [red, green, blue] = landCoverColor(landCover.sample(lon, lat));
          const colorIndex = vertexIndex * 4;
          worldCoverColors[colorIndex] = red;
          worldCoverColors[colorIndex + 1] = green;
          worldCoverColors[colorIndex + 2] = blue;
          worldCoverColors[colorIndex + 3] = 1;
        }
      }
    }

    // Recompute normals for correct lighting after modifying heights
    const normals = new Float32Array(positions.length);
    VertexData.ComputeNormals(positions, indices, normals);
    ground.updateVerticesData(VertexBuffer.PositionKind, positions);
    ground.updateVerticesData(VertexBuffer.NormalKind, normals);
    ground.metadata = { worldCoverColors } satisfies TerrainMetadata;

    this.applyDefaultTerrainMaterial(ground);

    return ground;
  }

  private applyDefaultTerrainMaterial(terrain: Mesh): void {
    terrain.material?.dispose(true, true);
    terrain.removeVerticesData(VertexBuffer.ColorKind);
    terrain.material = createTerrainMaterial(this.scene);
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
    const material = new StandardMaterial("worldCoverDebugMaterial", this.scene);
    material.diffuseColor = Color3.White();
    material.specularColor = new Color3(0.1, 0.1, 0.1);
    terrain.material = material;
  }
}
