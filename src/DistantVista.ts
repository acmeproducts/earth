import {
  Color3,
  Mesh,
  Scene,
  TransformNode,
  Vector3,
  VertexData,
} from "@babylonjs/core";
import { WaterMaterial } from "@babylonjs/materials";
import {
  lonLatToScene,
  sampleElevation,
  sceneToLonLat,
  sinkSubmergedElevation,
} from "./Geo";
import {
  MapFeatureLayer,
  MapTile,
  OpenStreetMap,
} from "./OpenStreetMap";
import { createTerrainMaterial } from "./TerrainMaterial";
import { TerrainResult } from "./TerrainTiles";
import { createTreeField, TreeFieldResult } from "./TreeField";
import {
  estimateVistaVegetationCandidates,
  vegetationDensityScaleAcrossLocalBoundary,
} from "./VistaVegetation";
import { landCoverSurfaceColor, WorldCover } from "./WorldCover";

const MAX_SOURCE_CELLS_ACROSS_OUTER_TERRAIN = 1024;
const INNER_OVERLAP = 1.5;
const SEAM_BLEND_WIDTH = 16;

interface VistaOptions {
  localTerrain: TerrainResult;
  localMeshWidth: number;
  localMeshDepth: number;
  metersPerUnit: number;
  distantLandCover?: WorldCover;
  localLandCover?: WorldCover;
  mapTiles: MapTile[];
  lakeElevationSource: Float32Array;
  waterMesh: Mesh;
  vegetationSpacingMeters: number;
}

interface Patch {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Owns the low-detail terrain, vegetation, and water surrounding the player area. */
export class DistantVista {
  readonly root: TransformNode;

  private readonly terrain: Mesh;
  private readonly mapFeatures: MapFeatureLayer;
  private readonly trees: TreeFieldResult;

  static async create(
    scene: Scene,
    distantTerrain: TerrainResult,
    options: VistaOptions,
  ): Promise<DistantVista> {
    if (!distantTerrain.bounds || !options.localTerrain.bounds) {
      throw new Error("Distant vista terrain bounds are unavailable.");
    }

    const distantWidth = distantTerrain.groundWidthMeters! / options.metersPerUnit;
    const distantDepth = distantTerrain.groundHeightMeters! / options.metersPerUnit;
    const distantCenter = sceneToLonLat(
      0,
      0,
      distantTerrain.bounds,
      distantWidth,
      distantDepth,
    );
    const offset = lonLatToScene(
      distantCenter.lon,
      distantCenter.lat,
      options.localTerrain.bounds,
      options.localMeshWidth,
      options.localMeshDepth,
    );
    const halfLocalWidth = options.localMeshWidth / 2;
    const halfLocalDepth = options.localMeshDepth / 2;
    const localTerrainMask = {
      intersects: (x: number, z: number, radius: number): boolean => {
        const worldX = x + offset.x;
        const worldZ = z + offset.z;
        return worldX + radius >= -halfLocalWidth && worldX - radius <= halfLocalWidth &&
          worldZ + radius >= -halfLocalDepth && worldZ - radius <= halfLocalDepth;
      },
    };
    console.log(
      `Distant vista source: ${options.vegetationSpacingMeters.toFixed(1)}m tree spacing, ` +
      `${estimateVistaVegetationCandidates(
        distantTerrain.groundWidthMeters!,
        distantTerrain.groundHeightMeters!,
        options.vegetationSpacingMeters,
      ).toLocaleString()} candidate positions`,
    );
    const trees = await createTreeField(scene, distantTerrain, {
      meshWidth: distantWidth,
      meshDepth: distantDepth,
      metersPerUnit: options.metersPerUnit,
      spacingMeters: options.vegetationSpacingMeters,
      densityScale: (worldX, worldZ) => vegetationDensityScaleAcrossLocalBoundary(
        worldX,
        worldZ,
        halfLocalWidth,
        halfLocalDepth,
        { innerScale: 1, borderScale: 1, outerScale: 1.12 },
      ),
      landCover: options.distantLandCover,
      exclusionMask: localTerrainMask,
      renderMode: "impostors",
      includeModels: false,
      forceLowestImpostorLod: true,
      positionOffset: new Vector3(offset.x, 0, offset.z),
      elevationSampler: (x, z) => sampleVistaElevation(
        distantTerrain,
        options,
        x + offset.x,
        z + offset.z,
      ),
      seed: distantTerrain.tile.z ^ distantTerrain.tile.x ^ (distantTerrain.tile.y << 8),
    });
    return new DistantVista(scene, distantTerrain, options, trees, offset);
  }

  private constructor(
    scene: Scene,
    distantTerrain: TerrainResult,
    options: VistaOptions,
    trees: TreeFieldResult,
    offset: { x: number; z: number },
  ) {
    if (!distantTerrain.bounds || !options.localTerrain.bounds) {
      throw new Error("Distant vista terrain bounds are unavailable.");
    }

    this.root = new TransformNode("distantVistaRoot", scene);
    this.trees = trees;
    this.terrain = createTerrainRing(scene, distantTerrain, options);
    this.terrain.parent = this.root;
    extendWaterMesh(options.waterMesh, this.terrain, options);
    this.mapFeatures = createDistantMapFeatures(scene, distantTerrain, options, offset);
    this.mapFeatures.root.parent = this.root;
    trees.root.parent = this.root;
    addWaterRenderMeshes(options.waterMesh, [
      this.terrain,
      ...trees.meshes,
      ...this.mapFeatures.meshes,
    ]);
    console.log(
      `Distant vista: ${(this.terrain.getTotalIndices() / 3).toLocaleString()} terrain triangles, ` +
      `${trees.count.toLocaleString()} trees, ` +
      `${this.mapFeatures.counts.buildings.toLocaleString()} buildings, ` +
      `${this.mapFeatures.counts.roads.toLocaleString()} roads, ` +
      `${this.mapFeatures.counts.water.toLocaleString()} water polygons`,
    );
  }

  dispose(): void {
    // Impostor atlases are shared with the replacement local scene.
    this.mapFeatures.root.dispose(false, true);
    const terrainMaterial = this.terrain.material;
    this.terrain.material = null;
    terrainMaterial?.dispose(true, true);
    this.root.dispose(false, false);
  }

  setAmbientOcclusionEnabled(enabled: boolean): void {
    this.trees.setAmbientOcclusionEnabled(enabled);
  }

}
function createDistantMapFeatures(
  scene: Scene,
  distantTerrain: TerrainResult,
  options: VistaOptions,
  offset: { x: number; z: number },
): MapFeatureLayer {
  const distantWidth = distantTerrain.groundWidthMeters! / options.metersPerUnit;
  const distantDepth = distantTerrain.groundHeightMeters! / options.metersPerUnit;
  const layer = OpenStreetMap.createLayer(scene, options.mapTiles, distantTerrain, {
    meshWidth: distantWidth,
    meshDepth: distantDepth,
    metersPerUnit: options.metersPerUnit,
    lakeElevationSource: options.lakeElevationSource,
    excludeBoundaryWater: true,
  });
  layer.root.position.set(offset.x, 0, offset.z);
  return layer;
}

function createTerrainRing(
  scene: Scene,
  distantTerrain: TerrainResult,
  options: VistaOptions,
): Mesh {
  const localBounds = options.localTerrain.bounds!;
  const distantBounds = distantTerrain.bounds!;
  const northWest = lonLatToScene(
    distantBounds.lonWest,
    distantBounds.latNorth,
    localBounds,
    options.localMeshWidth,
    options.localMeshDepth,
  );
  const southEast = lonLatToScene(
    distantBounds.lonEast,
    distantBounds.latSouth,
    localBounds,
    options.localMeshWidth,
    options.localMeshDepth,
  );
  const outer = {
    minX: northWest.x,
    maxX: southEast.x,
    minZ: southEast.z,
    maxZ: northWest.z,
  };
  const inner = {
    minX: -options.localMeshWidth / 2 + INNER_OVERLAP,
    maxX: options.localMeshWidth / 2 - INNER_OVERLAP,
    minZ: -options.localMeshDepth / 2 + INNER_OVERLAP,
    maxZ: options.localMeshDepth / 2 - INNER_OVERLAP,
  };
  const patches: Patch[] = [
    { x0: outer.minX, x1: outer.maxX, z0: inner.maxZ, z1: outer.maxZ },
    { x0: outer.minX, x1: outer.maxX, z0: outer.minZ, z1: inner.minZ },
    { x0: outer.minX, x1: inner.minX, z0: inner.minZ, z1: inner.maxZ },
    { x0: inner.maxX, x1: outer.maxX, z0: inner.minZ, z1: inner.maxZ },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const colors = options.distantLandCover ? [] as number[] : undefined;
  const sourceCellsAcross = Math.max(
    1,
    Math.min(MAX_SOURCE_CELLS_ACROSS_OUTER_TERRAIN, distantTerrain.width - 1),
  );
  const cellSize = Math.max(
    (outer.maxX - outer.minX) / sourceCellsAcross,
    0.01,
  );

  for (const patch of patches) {
    appendPatch(
      patch,
      Math.max(1, Math.ceil((patch.x1 - patch.x0) / cellSize)),
      Math.max(1, Math.ceil((patch.z1 - patch.z0) / cellSize)),
      positions,
      uvs,
      indices,
      colors,
      distantTerrain,
      options,
    );
  }

  VertexData.ComputeNormals(positions, indices, normals);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.normals = normals;
  vertexData.uvs = uvs;
  vertexData.indices = indices;
  if (colors) vertexData.colors = colors;

  const terrain = new Mesh("distantTerrainRing", scene);
  vertexData.applyToMesh(terrain, false);
  terrain.isPickable = false;
  terrain.alwaysSelectAsActiveMesh = true;
  terrain.useVertexColors = Boolean(colors);
  const material = createTerrainMaterial(scene, Boolean(colors));
  material.name = "distantTerrainMaterial";
  if (!colors) material.diffuseColor = new Color3(0.72, 0.76, 0.69);
  terrain.material = material;
  terrain.freezeWorldMatrix();
  return terrain;
}

function appendPatch(
  patch: Patch,
  xCells: number,
  zCells: number,
  positions: number[],
  uvs: number[],
  indices: number[],
  colors: number[] | undefined,
  distantTerrain: TerrainResult,
  options: VistaOptions,
): void {
  const vertexOffset = positions.length / 3;
  for (let row = 0; row <= zCells; row++) {
    const z = patch.z0 + ((patch.z1 - patch.z0) * row) / zCells;
    for (let column = 0; column <= xCells; column++) {
      const x = patch.x0 + ((patch.x1 - patch.x0) * column) / xCells;
      const { lon, lat } = sceneToLonLat(
        x,
        z,
        options.localTerrain.bounds!,
        options.localMeshWidth,
        options.localMeshDepth,
      );
      const clampedX = Math.max(
        -options.localMeshWidth / 2,
        Math.min(options.localMeshWidth / 2, x),
      );
      const clampedZ = Math.max(
        -options.localMeshDepth / 2,
        Math.min(options.localMeshDepth / 2, z),
      );
      const outsideX = Math.max(0, Math.abs(x) - options.localMeshWidth / 2);
      const outsideZ = Math.max(0, Math.abs(z) - options.localMeshDepth / 2);
      const seamBlend = smoothstep(0, SEAM_BLEND_WIDTH, Math.hypot(outsideX, outsideZ));
      const elevation = sampleVistaElevation(distantTerrain, options, x, z);
      positions.push(x, elevation / options.metersPerUnit, z);
      // Match the local terrain's material scale and phase. The texture wraps,
      // so coordinates outside the local footprint remain continuous.
      uvs.push(
        x / options.localMeshWidth + 0.5,
        z / options.localMeshDepth + 0.5,
      );
      if (colors && options.distantLandCover) {
        const distantColor = landCoverSurfaceColor(
          options.distantLandCover.sample(lon, lat),
        );
        let red = distantColor[0];
        let green = distantColor[1];
        let blue = distantColor[2];
        if (options.localLandCover && seamBlend < 1) {
          const localCoordinates = sceneToLonLat(
            clampedX,
            clampedZ,
            options.localTerrain.bounds!,
            options.localMeshWidth,
            options.localMeshDepth,
          );
          const localColor = landCoverSurfaceColor(
            options.localLandCover.sample(localCoordinates.lon, localCoordinates.lat),
          );
          red = localColor[0] + (red - localColor[0]) * seamBlend;
          green = localColor[1] + (green - localColor[1]) * seamBlend;
          blue = localColor[2] + (blue - localColor[2]) * seamBlend;
        }
        colors.push(red, green, blue, 1);
      }
    }
  }

  const verticesPerRow = xCells + 1;
  for (let row = 0; row < zCells; row++) {
    for (let column = 0; column < xCells; column++) {
      const topLeft = vertexOffset + row * verticesPerRow + column;
      const bottomLeft = topLeft + verticesPerRow;
      // Babylon's left-handed ground meshes use clockwise front faces.
      indices.push(topLeft + 1, bottomLeft, topLeft);
      indices.push(bottomLeft + 1, bottomLeft, topLeft + 1);
    }
  }
}

function sampleVistaElevation(
  distantTerrain: TerrainResult,
  options: VistaOptions,
  x: number,
  z: number,
): number {
  const distantWidth = distantTerrain.groundWidthMeters! / options.metersPerUnit;
  const distantDepth = distantTerrain.groundHeightMeters! / options.metersPerUnit;
  const { lon, lat } = sceneToLonLat(
    x,
    z,
    options.localTerrain.bounds!,
    options.localMeshWidth,
    options.localMeshDepth,
  );
  const distantPoint = lonLatToScene(
    lon,
    lat,
    distantTerrain.bounds!,
    distantWidth,
    distantDepth,
  );
  const clampedX = Math.max(
    -options.localMeshWidth / 2,
    Math.min(options.localMeshWidth / 2, x),
  );
  const clampedZ = Math.max(
    -options.localMeshDepth / 2,
    Math.min(options.localMeshDepth / 2, z),
  );
  const localElevation = sampleElevation(
    options.localTerrain,
    clampedX,
    clampedZ,
    options.localMeshWidth,
    options.localMeshDepth,
  );
  const distantElevation = sampleElevation(
    distantTerrain,
    distantPoint.x,
    distantPoint.z,
    distantWidth,
    distantDepth,
  );
  const outsideX = Math.max(0, Math.abs(x) - options.localMeshWidth / 2);
  const outsideZ = Math.max(0, Math.abs(z) - options.localMeshDepth / 2);
  const blend = smoothstep(0, SEAM_BLEND_WIDTH, Math.hypot(outsideX, outsideZ));
  // The local/distant seam blend can recreate shallow submerged elevations
  // after both source grids were sunk, so clamp the final rendered sample too.
  return sinkSubmergedElevation(
    localElevation + (distantElevation - localElevation) * blend,
  );
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return amount * amount * (3 - 2 * amount);
}

function addWaterRenderMeshes(waterMesh: Mesh, meshes: Mesh[]): void {
  const material = waterMesh.material;
  if (!(material instanceof WaterMaterial)) {
    throw new Error("Local water mesh does not use a WaterMaterial.");
  }
  for (const mesh of meshes) material.addToRenderList(mesh);
}

function extendWaterMesh(water: Mesh, terrain: Mesh, options: VistaOptions): void {
  terrain.refreshBoundingInfo();
  const bounds = terrain.getBoundingInfo().boundingBox;
  const outer = {
    minX: bounds.minimumWorld.x,
    maxX: bounds.maximumWorld.x,
    minZ: bounds.minimumWorld.z,
    maxZ: bounds.maximumWorld.z,
  };
  const halfWaterWidth = options.localMeshWidth * 0.6;
  const halfWaterDepth = options.localMeshDepth * 0.6;
  const patches: Patch[] = [
    { x0: outer.minX, x1: outer.maxX, z0: halfWaterDepth, z1: outer.maxZ },
    { x0: outer.minX, x1: outer.maxX, z0: outer.minZ, z1: -halfWaterDepth },
    { x0: outer.minX, x1: -halfWaterWidth, z0: -halfWaterDepth, z1: halfWaterDepth },
    { x0: halfWaterWidth, x1: outer.maxX, z0: -halfWaterDepth, z1: halfWaterDepth },
  ];
  const positions = Array.from(water.getVerticesData("position") ?? []);
  const normals = Array.from(water.getVerticesData("normal") ?? []);
  const uvs = Array.from(water.getVerticesData("uv") ?? []);
  const indices = Array.from(water.getIndices() ?? []);
  if (positions.length === 0 || normals.length === 0 || uvs.length === 0) {
    throw new Error("Local water mesh is missing required vertex data.");
  }
  for (const patch of patches) {
    const offset = positions.length / 3;
    positions.push(
      patch.x0, 0, patch.z0,
      patch.x1, 0, patch.z0,
      patch.x0, 0, patch.z1,
      patch.x1, 0, patch.z1,
    );
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    uvs.push(
      patch.x0 / (options.localMeshWidth * 1.2) + 0.5,
      patch.z0 / (options.localMeshDepth * 1.2) + 0.5,
      patch.x1 / (options.localMeshWidth * 1.2) + 0.5,
      patch.z0 / (options.localMeshDepth * 1.2) + 0.5,
      patch.x0 / (options.localMeshWidth * 1.2) + 0.5,
      patch.z1 / (options.localMeshDepth * 1.2) + 0.5,
      patch.x1 / (options.localMeshWidth * 1.2) + 0.5,
      patch.z1 / (options.localMeshDepth * 1.2) + 0.5,
    );
    indices.push(offset + 1, offset + 2, offset, offset + 3, offset + 2, offset + 1);
  }
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.normals = normals;
  vertexData.uvs = uvs;
  vertexData.applyToMesh(water, false);
  water.refreshBoundingInfo();
}
