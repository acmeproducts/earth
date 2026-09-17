import {
  Mesh,
  MeshBuilder,
  Scene,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import type { TerrainData } from "./TerrainData";
import { sampleElevation, sceneToLonLat, SEA_LEVEL_METERS, sinkSubmergedElevation } from "../world/Geo";
import { beachSurfaceColor } from "./BeachSurface";
import { attachShoreline } from "../water/Shoreline";
import { varyGroundColor } from "./GroundVariation";
import {
  createTerrainMaterial,
  isSharedTerrainMaterial,
} from "./TerrainMaterial";
import {
  createTerrainSkirtGeometry,
  stitchTerrainMeshEdges,
} from "./TerrainStitching";
import { landCoverSurfaceColor } from "../world/WorldCover";
import type { LandCoverClass, LandCoverSampler } from "../world/WorldCover";
import { DEFAULT_WORLD_SEED } from "../world/WorldGrid";
import type { FrameBudgetYielder } from "../diagnostics/FrameBudget";
import { attachTerrainReliefNormals } from "./TerrainReliefNormals";
import type { StreamingTrace } from "../diagnostics/StreamingDiagnostics";

const GROUND_COVER_BLEND_METERS = 12;
const FAR_TILE_SUBDIVISIONS = 32;
const TERRAIN_SKIRT_OVERLAP_METERS = 0.5;
const TERRAIN_SKIRT_SURFACE_DROP_METERS = 0.02;

export interface TerrainMeshOptions {
  meshWidth: number;
  meshDepth: number;
  subdivisions: number;
  metersPerUnit: number;
  landCover?: LandCoverSampler;
  yieldControl?: FrameBudgetYielder;
  trace?: StreamingTrace;
  snowCovered?: boolean;
  /** World-level seed for the ground color bands, not the per-tile seed. */
  worldSeed?: number;
}

interface TerrainMeshMetadata {
  surfaceColors?: Float32Array;
  skirt?: Mesh;
  snowCovered: boolean;
}

/** Builds the renderable mesh and material for one processed terrain tile. */
export async function createTerrainMesh(
  scene: Scene,
  name: string,
  terrain: TerrainData,
  options: TerrainMeshOptions,
): Promise<Mesh> {
  const {
    meshWidth,
    meshDepth,
    subdivisions,
    metersPerUnit,
    landCover,
    yieldControl,
    trace,
    snowCovered = false,
    worldSeed = DEFAULT_WORLD_SEED,
  } = options;

  // Ground creation allocates and uploads the initial flat vertex buffers.
  // Each step below is well under a millisecond for far tiles, so only budget
  // exhaustion yields a frame: forced frame waits cost far more than the work.
  trace?.stage("ground creation frame wait");
  await yieldControl?.();
  trace?.stage("ground creation and initial buffers", "synchronous");
  const ground = MeshBuilder.CreateGround(
    name,
    { width: meshWidth, height: meshDepth, subdivisions, updatable: true },
    scene,
  );
  // A cooperative build renders frames while the vertices are still flat;
  // the caller re-enables the mesh when it commits the finished terrain.
  if (yieldControl) ground.setEnabled(false);

  const positions = ground.getVerticesData(VertexBuffer.PositionKind)!;
  const uvs = ground.getVerticesData(VertexBuffer.UVKind)!;
  const indices = ground.getIndices()!;
  const { elevations, width: elevationWidth, height: elevationHeight } = terrain;
  const verticesPerRow = subdivisions + 1;
  const surfaceColors = landCover
    ? new Float32Array((positions.length / 3) * 4)
    : undefined;
  // Retain the sampled classes so variation does not have to resample the raster.
  const coverClasses = landCover
    ? new Uint8Array(positions.length / 3)
    : undefined;

  trace?.stage("terrain vertex elevation and land cover sampling");
  for (let row = 0; row < verticesPerRow; row++) {
    for (let column = 0; column < verticesPerRow; column++) {
      const u = column / subdivisions;
      const v = row / subdivisions;
      const pixelX = u * (elevationWidth - 1);
      const pixelY = v * (elevationHeight - 1);
      const x0 = Math.floor(pixelX);
      const y0 = Math.floor(pixelY);
      const x1 = Math.min(x0 + 1, elevationWidth - 1);
      const y1 = Math.min(y0 + 1, elevationHeight - 1);
      const fractionX = pixelX - x0;
      const fractionY = pixelY - y0;
      const elevation00 = elevations[y0 * elevationWidth + x0];
      const elevation10 = elevations[y0 * elevationWidth + x1];
      const elevation01 = elevations[y1 * elevationWidth + x0];
      const elevation11 = elevations[y1 * elevationWidth + x1];
      const interpolatedElevation =
        elevation00 * (1 - fractionX) * (1 - fractionY) +
        elevation10 * fractionX * (1 - fractionY) +
        elevation01 * (1 - fractionX) * fractionY +
        elevation11 * fractionX * fractionY;
      // Classified coastlines already contain their shallow-to-deep profile.
      const elevation = terrain.waterMask
        ? interpolatedElevation
        : sinkSubmergedElevation(interpolatedElevation);

      const vertexIndex = row * verticesPerRow + column;
      positions[vertexIndex * 3 + 1] = elevation / metersPerUnit;
      // UVs use physical metres so all tiles can share terrain textures.
      uvs[vertexIndex * 2] *= terrain.groundWidthMeters;
      uvs[vertexIndex * 2 + 1] *= terrain.groundHeightMeters;

      if (surfaceColors && landCover) {
        const { lon, lat } = sceneToLonLat(
          positions[vertexIndex * 3],
          positions[vertexIndex * 3 + 2],
          terrain.bounds,
          meshWidth,
          meshDepth,
        );
        const coverClass = landCover.sample(lon, lat);
        const color = landCover.sampleSurfaceColor?.(lon, lat) ??
          landCoverSurfaceColor(coverClass);
        const colorIndex = vertexIndex * 4;
        surfaceColors[colorIndex] = color[0];
        surfaceColors[colorIndex + 1] = color[1];
        surfaceColors[colorIndex + 2] = color[2];
        surfaceColors[colorIndex + 3] = 1;
        coverClasses![vertexIndex] = coverClass;
      }
    }
    await yieldControl?.();
  }

  trace?.stage("terrain mesh edge stitching", "synchronous");
  stitchTerrainMeshEdges(
    positions,
    subdivisions,
    Math.min(FAR_TILE_SUBDIVISIONS, subdivisions),
  );

  if (surfaceColors && coverClasses) {
    const metersPerVertex = Math.min(
      terrain.groundWidthMeters / subdivisions,
      terrain.groundHeightMeters / subdivisions,
    );
    trace?.stage("terrain vertex color smoothing");
    await smoothVertexColors(
      surfaceColors,
      verticesPerRow,
      Math.max(1, Math.round(GROUND_COVER_BLEND_METERS / metersPerVertex)),
      yieldControl,
    );
    trace?.stage("terrain ground color variation");
    await applyGroundVariation(surfaceColors, coverClasses, positions, terrain, {
      meshWidth,
      meshDepth,
      metersPerVertex,
      worldSeed,
    }, yieldControl);
    // Apply after land-cover smoothing so green tint cannot bleed back over
    // the beach. Sample the same padded contour used to shape the terrain.
    if (terrain.shoreDistanceMeters) {
      trace?.stage("terrain beach vertex colors");
      for (let index = 0; index < coverClasses.length; index++) {
        const target = index * 4;
        const distance = sampleElevation(terrain, positions[index * 3],
          positions[index * 3 + 2], meshWidth, meshDepth, terrain.shoreDistanceMeters);
        const color = beachSurfaceColor(
          [surfaceColors[target], surfaceColors[target + 1], surfaceColors[target + 2]],
          distance, positions[index * 3 + 1] * metersPerUnit,
        );
        surfaceColors.set(color, target);
        if ((index & 511) === 511) await yieldControl?.();
      }
    }
  }

  trace?.stage("terrain normals frame wait");
  await yieldControl?.();
  trace?.stage("terrain normal computation", "synchronous");
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  // Upload positions before normals so Babylon refreshes the formerly flat bounds.
  trace?.stage("terrain position upload frame wait");
  await yieldControl?.();
  trace?.stage("terrain position upload and bounds", "synchronous");
  ground.updateVerticesData(VertexBuffer.PositionKind, positions, true);
  trace?.stage("terrain normal upload frame wait");
  await yieldControl?.();
  trace?.stage("terrain normal upload", "synchronous");
  ground.updateVerticesData(VertexBuffer.NormalKind, normals);
  trace?.stage("terrain UV upload frame wait");
  await yieldControl?.();
  trace?.stage("terrain UV upload", "synchronous");
  ground.updateVerticesData(VertexBuffer.UVKind, uvs);

  trace?.stage("terrain skirt geometry", "synchronous");
  const skirtGeometry = createTerrainSkirtGeometry(
    positions,
    uvs,
    subdivisions,
    Math.min(SEA_LEVEL_METERS - 1, terrain.minElevation - 1) / metersPerUnit,
    surfaceColors,
    TERRAIN_SKIRT_OVERLAP_METERS / metersPerUnit,
    TERRAIN_SKIRT_SURFACE_DROP_METERS / metersPerUnit,
    normals,
  );
  trace?.stage("terrain skirt mesh and buffers", "synchronous");
  const skirt = new Mesh(`${name} skirt`, scene);
  const skirtVertexData = new VertexData();
  skirtVertexData.positions = skirtGeometry.positions;
  skirtVertexData.uvs = skirtGeometry.uvs;
  skirtVertexData.indices = skirtGeometry.indices;
  skirtVertexData.normals = skirtGeometry.normals;
  if (skirtGeometry.colors) skirtVertexData.colors = skirtGeometry.colors;
  skirtVertexData.applyToMesh(skirt);
  skirt.parent = ground;
  skirt.isPickable = false;
  skirt.checkCollisions = false;
  ground.metadata = {
    surfaceColors,
    skirt,
    snowCovered,
  } satisfies TerrainMeshMetadata;
  ground.freezeWorldMatrix();

  trace?.stage("terrain material frame wait");
  await yieldControl?.();
  trace?.stage("terrain material and textures", "synchronous");
  applyDefaultTerrainMaterial(scene, ground);
  trace?.stage("terrain relief normal attachment", "synchronous");
  attachTerrainReliefNormals(ground, terrain, meshWidth, meshDepth);
  if (terrain.shoreDistanceMeters) {
    trace?.stage("terrain shoreline attachment");
    await attachShoreline(ground, positions, indices, metersPerUnit, yieldControl);
  }
  trace?.stage("terrain mesh return");
  return ground;
}

/** Switches snow on an existing tile without rebuilding or fetching terrain. */
export function setTerrainSnowCovered(scene: Scene, terrain: Mesh, snowCovered: boolean): void {
  const metadata = terrain.metadata as TerrainMeshMetadata | null;
  if (!metadata || metadata.snowCovered === snowCovered) return;
  metadata.snowCovered = snowCovered;
  applyDefaultTerrainMaterial(scene, terrain);
}

/** Rebuilds a terrain tile's shared material from its mesh metadata. */
export function applyDefaultTerrainMaterial(scene: Scene, terrain: Mesh): void {
  disposeTerrainAppearance(terrain);
  const metadata = terrain.metadata as TerrainMeshMetadata | null;
  const colors = metadata?.surfaceColors;
  const snowCovered = Boolean(metadata?.snowCovered);
  if (colors && !snowCovered) {
    terrain.setVerticesData(VertexBuffer.ColorKind, colors);
    terrain.useVertexColors = true;
  } else {
    terrain.removeVerticesData(VertexBuffer.ColorKind);
    terrain.useVertexColors = false;
  }
  const material = createTerrainMaterial(scene, {
    usesLandCoverTint: Boolean(colors),
    snowCovered,
  });
  terrain.material = material;
  const skirt = metadata?.skirt;
  if (skirt) {
    skirt.material = material;
    skirt.useVertexColors = Boolean(colors) && !snowCovered;
  }
}

function disposeTerrainAppearance(terrain: Mesh): void {
  const material = terrain.material;
  if (material && !isSharedTerrainMaterial(material)) material.dispose(true, true);
  terrain.material = null;
}

async function applyGroundVariation(
  colors: Float32Array,
  coverClasses: Uint8Array,
  positions: Float32Array | number[],
  terrain: TerrainData,
  options: {
    meshWidth: number;
    meshDepth: number;
    metersPerVertex: number;
    worldSeed: number;
  },
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
      options.worldSeed,
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
