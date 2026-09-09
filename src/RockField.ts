import {
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  RawTexture,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import { isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "./Geo";
import { createSeededRandom } from "./Random";
import { getRockTextureData } from "./RockTextureData";
import type { TerrainData } from "./TerrainData";
import {
  createPlacementGrid,
  packInstanceMatrices,
  type VegetationPlacementOptions,
} from "./VegetationPlacement";
import { LandCoverClass } from "./WorldCover";
import type { LandCoverSampler } from "./WorldCover";
import { DEFAULT_WORLD_SEED } from "./WorldGrid";
import { habitatField } from "./HabitatNoise";
import type { HabitatFieldSpec } from "./HabitatNoise";
import { hasWinterGroundCover } from "./TreeSeason";

export interface RockFieldResult {
  root: TransformNode;
  meshes: Mesh[];
  count: number;
  setFade(fade: number): void;
  setSnowCovered(snowCovered: boolean): void;
}

/** Three rounded, weathered shapes followed by two blocky, fractured ones. */
const ROCK_VARIANTS = 5;
const ROUNDED_VARIANTS = 3;
const ANGULAR_CHANCE = 0.35;
/**
 * Most stones are hand- to knee-sized, but a landscape with no boulder above
 * two metres reads as gravel. The rare tail sits well outside the ordinary
 * size curve so it registers as an event rather than a slightly larger stone.
 */
const BOULDER_CHANCE = 0.025;
const SHORE_BOULDER_CHANCE = 0.03;
const SHORE_PROBE_METERS = 7;
/**
 * Shore boulders come in formations with clear stretches between them, on the
 * same world-anchored footing as the inland scatter. Multiplying by the stand
 * rather than thresholding it lets a formation thin out at its margins instead
 * of ending on a contour line. Calibrated to the mean the old threshold gave.
 */
const SHORE_HABITAT: HabitatFieldSpec = {
  patchMeters: 38,
  abundanceMeters: 1200,
  barrenShare: 0.1,
  richestCoverage: 0.85,
};
const SHORE_FORMATION_CHANCE = 0.55;
/**
 * Stony ground comes in fields. A flat land-cover scatter dusts every hillside
 * in the world equally, so nothing reads as a boulder field and nothing reads
 * as clear.
 */
const HABITAT: HabitatFieldSpec = {
  patchMeters: 150,
  abundanceMeters: 2000,
  barrenShare: 0.34,
  richestCoverage: 0.95,
};

/** Ground that is stony by nature thins out but never clears completely. */
const STONY_COVERS: ReadonlySet<LandCoverClass> = new Set([
  LandCoverClass.Bare,
  LandCoverClass.MossAndLichen,
  LandCoverClass.SnowAndIce,
]);
const STONY_FLOOR = 0.4;
const SHORE_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
const ROCK_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [0.41, 0.41, 0.4],
  [0.36, 0.38, 0.38],
  [0.44, 0.43, 0.41],
  [0.38, 0.37, 0.36],
  [0.42, 0.4, 0.37],
];
const MOSS_COLOR: readonly [number, number, number] = [0.25, 0.32, 0.13];

const INLAND_OCCUPANCY: Readonly<Partial<Record<LandCoverClass, number>>> = {
  [LandCoverClass.TreeCover]: 0.05,
  [LandCoverClass.Shrubland]: 0.09,
  [LandCoverClass.Grassland]: 0.015,
  [LandCoverClass.Cropland]: 0.008,
  [LandCoverClass.Bare]: 0.22,
  [LandCoverClass.SnowAndIce]: 0.12,
  [LandCoverClass.Wetland]: 0.07,
  [LandCoverClass.Mangrove]: 0.055,
  [LandCoverClass.MossAndLichen]: 0.2,
};

const MOSS_CHANCE: Readonly<Partial<Record<LandCoverClass, number>>> = {
  [LandCoverClass.TreeCover]: 0.58,
  [LandCoverClass.Shrubland]: 0.38,
  [LandCoverClass.Grassland]: 0.25,
  [LandCoverClass.Cropland]: 0.1,
  [LandCoverClass.Bare]: 0.08,
  [LandCoverClass.SnowAndIce]: 0.04,
  [LandCoverClass.Wetland]: 0.5,
  [LandCoverClass.Mangrove]: 0.62,
  [LandCoverClass.MossAndLichen]: 0.78,
};

interface RockPlacementContext {
  terrain: TerrainData;
  landCover: LandCoverSampler;
  exclusionMask: VegetationPlacementOptions["exclusionMask"];
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  waterLineMeters: number;
  random: () => number;
  buckets: Matrix[][];
}

interface ShoreDirection {
  /** Unit vector following the local shoreline. */
  tangentX: number;
  tangentZ: number;
  /** Unit vector pointing from land toward water. */
  waterX: number;
  waterZ: number;
}

/** Places partly buried boulders on suitable natural ground. */
export async function createRockField(
  scene: Scene,
  terrain: TerrainData,
  options: VegetationPlacementOptions,
): Promise<RockFieldResult> {
  const {
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x524f434b,
    modelVariantSeed = DEFAULT_WORLD_SEED,
    spacingMeters = 8,
    waterLineMeters = 0,
    landCover,
    exclusionMask,
    densityScale,
    yieldControl,
    startDisabled = false,
  } = options;
  const root = new TransformNode("rockField", scene);
  if (startDisabled) root.setEnabled(false);
  const random = createSeededRandom(seed);
  const habitat = habitatField("rocks", modelVariantSeed, HABITAT);
  const shoreHabitat = habitatField("rockShores", modelVariantSeed, SHORE_HABITAT);
  const { columns, rows, cellWidth, cellDepth } = createPlacementGrid(
    meshWidth,
    meshDepth,
    spacingMeters,
    metersPerUnit,
  );
  const buckets = Array.from({ length: ROCK_VARIANTS * 2 }, () => [] as Matrix[]);

  if (landCover) {
    const placement: RockPlacementContext = {
      terrain,
      landCover,
      exclusionMask,
      meshWidth,
      meshDepth,
      metersPerUnit,
      waterLineMeters,
      random,
      buckets,
    };
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = -meshWidth / 2 + (column + 0.08 + random() * 0.84) * cellWidth;
        const z = meshDepth / 2 - (row + 0.08 + random() * 0.84) * cellDepth;
        const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
        const cover = landCover.sample(lon, lat);
        if (cover === LandCoverClass.Water || cover === LandCoverClass.BuiltUp) continue;

        const shore = shorelineDirection(
          landCover,
          terrain,
          x,
          z,
          meshWidth,
          meshDepth,
          metersPerUnit,
        );
        if (shore) {
          const formation = shoreHabitat.sample(lon, lat);
          if (
            formation > 0 &&
            random() < Math.min(
              1,
              SHORE_FORMATION_CHANCE * formation *
                Math.max(0, densityScale?.(x, z) ?? 1),
            )
          ) {
            addShoreFormation(placement, shore, x, z);
          }
          // Shore rocks belong to formations; do not mix in the even inland scatter.
          continue;
        }

        const stand = habitat.sample(lon, lat);
        const field = STONY_COVERS.has(cover)
          ? STONY_FLOOR + stand * (1 - STONY_FLOOR)
          : stand;
        if (field <= 0) continue;

        const occupancy = Math.min(
          1,
          (INLAND_OCCUPANCY[cover] ?? 0) * field * 1.8 *
            Math.max(0, densityScale?.(x, z) ?? 1),
        );
        if (random() > occupancy) continue;

        // Mostly hand-sized stones, with a long tail into isolated boulders and
        // the rare car-sized block.
        const radiusMeters = random() < BOULDER_CHANCE
          ? 2.2 + Math.pow(random(), 1.6) * 2.8
          : 0.22 + Math.pow(random(), 2.1) * 1.65;
        addRock(placement, x, z, radiusMeters);
      }
      await yieldControl?.();
    }
  }

  let material: StandardMaterial | undefined;
  const meshes: Mesh[] = [];
  let count = 0;
  for (let variant = 0; variant < ROCK_VARIANTS; variant++) {
    for (let mossIndex = 0; mossIndex < 2; mossIndex++) {
      const matrices = buckets[variant * 2 + mossIndex];
      if (matrices.length === 0) continue;
      const rock = createRockMesh(scene, variant, mossIndex === 1);
      rock.parent = root;
      rock.material = material ??= createRockMaterial(scene);
      rock.isPickable = false;
      rock.receiveShadows = true;
      rock.thinInstanceSetBuffer(
        "matrix",
        await packInstanceMatrices(matrices, yieldControl),
        16,
        true,
      );
      rock.thinInstanceRefreshBoundingInfo(true);
      rock.freezeWorldMatrix();
      meshes.push(rock);
      count += matrices.length;
      await yieldControl?.();
    }
  }

  const setSnowCovered = (snowCovered: boolean): void => {
    for (const mesh of meshes) mesh.useVertexColors = !snowCovered;
    if (!material) return;
    material.unfreeze();
    material.diffuseColor = snowCovered ? new Color3(0.9, 0.94, 0.98) : Color3.White();
    material.specularColor = snowCovered
      ? new Color3(0.16, 0.18, 0.2)
      : new Color3(0.055, 0.06, 0.05);
    material.specularPower = snowCovered ? 48 : 18;
    material.freeze();
  };
  setSnowCovered(hasWinterGroundCover(
    options.seasonalDate,
    (terrain.bounds.latNorth + terrain.bounds.latSouth) / 2,
  ));

  return {
    root,
    meshes,
    count,
    setSnowCovered,
    setFade: (fade: number) => {
      const visibility = Math.max(0, Math.min(1, fade));
      for (const mesh of meshes) mesh.visibility = visibility;
    },
  };
}

/** Estimates the local shoreline tangent from nearby land-cover samples. */
function shorelineDirection(
  landCover: LandCoverSampler,
  terrain: TerrainData,
  x: number,
  z: number,
  meshWidth: number,
  meshDepth: number,
  metersPerUnit: number,
): ShoreDirection | undefined {
  const probe = SHORE_PROBE_METERS / metersPerUnit;
  const water = SHORE_DIRECTIONS.map(([directionX, directionZ]) => {
    const location = sceneToLonLat(
      x + directionX * probe,
      z + directionZ * probe,
      terrain.bounds,
      meshWidth,
      meshDepth,
    );
    return landCover.sample(location.lon, location.lat) === LandCoverClass.Water ? 1 : 0;
  });
  const waterX = water[1] - water[0];
  const waterZ = water[3] - water[2];
  const length = Math.hypot(waterX, waterZ);
  if (length === 0) return undefined;
  return {
    tangentX: -waterZ / length,
    tangentZ: waterX / length,
    waterX: waterX / length,
    waterZ: waterZ / length,
  };
}

/** Adds one dense, irregular chain parallel to the sampled water boundary. */
function addShoreFormation(
  context: RockPlacementContext,
  shore: ShoreDirection,
  anchorX: number,
  anchorZ: number,
): void {
  const { metersPerUnit, random } = context;
  const lengthMeters = 12 + random() * 18;
  const spacingMeters = 1.15 + random() * 0.8;
  const count = Math.max(6, Math.round(lengthMeters / spacingMeters));
  const inlandOffsetMeters = 0.8 + random() * 2.2;
  for (let index = 0; index < count; index++) {
    const progress = count === 1 ? 0 : index / (count - 1) - 0.5;
    const alongMeters = progress * lengthMeters + (random() - 0.5) * spacingMeters * 0.65;
    const acrossMeters = inlandOffsetMeters + (random() - 0.5) * 2.4;
    const x = anchorX + (
      shore.tangentX * alongMeters - shore.waterX * acrossMeters
    ) / metersPerUnit;
    const z = anchorZ + (
      shore.tangentZ * alongMeters - shore.waterZ * acrossMeters
    ) / metersPerUnit;
    const radiusMeters = random() < SHORE_BOULDER_CHANCE
      ? 1.6 + Math.pow(random(), 1.6) * 1.9
      : 0.18 + Math.pow(random(), 1.7) * 1.15;
    addRock(context, x, z, radiusMeters, 0.12);
  }
}

/** Validates one candidate and appends its transform to the matching render bucket. */
function addRock(
  context: RockPlacementContext,
  x: number,
  z: number,
  radiusMeters: number,
  mossBonus = 0,
): boolean {
  const {
    terrain,
    landCover,
    exclusionMask,
    meshWidth,
    meshDepth,
    metersPerUnit,
    waterLineMeters,
    random,
    buckets,
  } = context;
  if (Math.abs(x) > meshWidth / 2 || Math.abs(z) > meshDepth / 2) return false;
  const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
  const cover = landCover.sample(lon, lat);
  if (cover === LandCoverClass.Water || cover === LandCoverClass.BuiltUp) return false;

  const halfFootprint = radiusMeters * (0.72 + random() * 0.42) / metersPerUnit;
  if (exclusionMask?.intersects(x, z, halfFootprint)) return false;
  if (!isTerrainFootprintAbove(
    terrain,
    x,
    z,
    halfFootprint,
    halfFootprint,
    meshWidth,
    meshDepth,
    waterLineMeters,
  )) return false;

  const elevation = sampleElevation(terrain, x, z, meshWidth, meshDepth);
  const scaleX = radiusMeters * (0.82 + random() * 0.5) / metersPerUnit;
  const scaleY = radiusMeters * (0.5 + random() * 0.5) / metersPerUnit;
  const scaleZ = radiusMeters * (0.82 + random() * 0.5) / metersPerUnit;
  const deepSet = random() < 0.3;
  const burial = deepSet ? 0.72 + random() * 0.16 : 0.38 + random() * 0.28;
  const centerY = elevation / metersPerUnit + scaleY * (1 - burial * 2);
  const rotation = Quaternion.RotationYawPitchRoll(
    random() * Math.PI * 2,
    (random() - 0.5) * 0.34,
    (random() - 0.5) * 0.34,
  );
  const mossChance = Math.min(0.9, (MOSS_CHANCE[cover] ?? 0.12) + mossBonus);
  const mossy = random() < mossChance;
  const variant = random() < ANGULAR_CHANCE
    ? ROUNDED_VARIANTS +
      Math.min(ROCK_VARIANTS - ROUNDED_VARIANTS - 1,
        Math.floor(random() * (ROCK_VARIANTS - ROUNDED_VARIANTS)))
    : Math.min(ROUNDED_VARIANTS - 1, Math.floor(random() * ROUNDED_VARIANTS));
  buckets[variant * 2 + (mossy ? 1 : 0)].push(Matrix.Compose(
    new Vector3(scaleX, scaleY, scaleZ),
    rotation,
    new Vector3(x, centerY, z),
  ));
  return true;
}

function createRockMaterial(scene: Scene): StandardMaterial {
  const material = new StandardMaterial("rockMaterial", scene);
  material.diffuseColor = Color3.White();
  material.ambientColor = new Color3(0.16, 0.17, 0.14);
  material.specularColor = new Color3(0.055, 0.06, 0.05);
  material.specularPower = 18;

  // Both slots decode their texels as tangent-space normals, so they must be
  // fed encoded normal maps rather than raw noise. The pixel data is generated
  // once per page; the GPU textures belong to this material because each tile
  // disposes its rock field together with its textures.
  const textures = getRockTextureData();
  const relief = createRockTexture(textures.normal, textures.size, "rockRelief", 5.4, scene);
  relief.level = 0.7;
  material.bumpTexture = relief;
  material.detailMap.texture = createRockTexture(
    textures.detail,
    textures.size,
    "rockDetail",
    13,
    scene,
  );
  material.detailMap.diffuseBlendLevel = 0.3;
  material.detailMap.bumpLevel = 0.45;
  material.detailMap.isEnabled = true;
  material.freeze();
  return material;
}

function createRockTexture(
  data: Uint8Array,
  size: number,
  name: string,
  repeats: number,
  scene: Scene,
): Texture {
  const texture = RawTexture.CreateRGBATexture(
    data,
    size,
    size,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  texture.name = name;
  // Raw channel values; nothing here is a color to be linearized.
  texture.gammaSpace = false;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.uScale = repeats;
  texture.vScale = repeats;
  return texture;
}

/**
 * Builds an asymmetrically deformed stone with optional top moss. Rounded
 * variants are smoothly shaded; angular variants are clipped against a handful
 * of fracture planes and shaded per face so the resulting edges stay hard.
 */
export function createRockMesh(scene: Scene, variant: number, mossy: boolean): Mesh {
  const angular = variant >= ROUNDED_VARIANTS;
  const rock = MeshBuilder.CreateIcoSphere(
    `rock-${variant}-${mossy ? "mossy" : "bare"}`,
    // Facets need enough triangles to lie wholly on one fracture plane.
    { radius: 1, subdivisions: angular ? 4 : 2, flat: angular },
    scene,
  );
  const positions = rock.getVerticesData(VertexBuffer.PositionKind)!;
  const indices = rock.getIndices()!;
  const random = createSeededRandom(0x726f636b ^ Math.imul(variant + 1, 0x9e3779b9));
  const stretchX = 0.88 + random() * 0.22;
  const stretchZ = 0.88 + random() * 0.22;
  const offsetX = (random() - 0.5) * 0.18;
  const offsetZ = (random() - 0.5) * 0.18;
  // A blocky stone keeps its facets flat, so it takes only a whisper of the
  // organic warp that gives the rounded ones their lumpiness.
  const warpScale = angular ? 0.35 : 1;
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index];
    const y = positions[index + 1];
    const z = positions[index + 2];
    const angularWarp = 1 + warpScale * (
      0.1 * Math.sin(x * 7.1 + z * 4.7 + variant * 2.3) +
      0.055 * Math.sin(y * 9.3 - x * 3.8)
    );
    positions[index] = (x * stretchX + offsetX * (1 - y * y)) * angularWarp;
    positions[index + 1] = y * (0.9 + 0.08 * warpScale * Math.sin(x * 5.4 + z * 6.2));
    positions[index + 2] = (z * stretchZ + offsetZ * (1 - y * y)) * angularWarp;
  }
  const facets = angular ? clipToFracturePlanes(positions, random) : [];
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  // Babylon's icosphere duplicates vertices per face whatever `flat` says, so
  // the recomputed normals are faceted until coincident vertices are averaged.
  smoothNormalsOffFacets(positions, indices, normals, facets);
  const colors = new Float32Array((positions.length / 3) * 4);
  const stone = ROCK_COLORS[variant];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const y = positions[vertex * 3 + 1];
    const upward = normals[vertex * 3 + 1];
    const x = positions[vertex * 3];
    const z = positions[vertex * 3 + 2];
    const patch = Math.sin(x * 5.7 + z * 7.9 + variant);
    const fineGrain = Math.sin(x * 23.7 - y * 17.3 + z * 29.1 + variant * 3.7);
    const darkInclusion = fineGrain < -0.82 && patch < 0.25;
    const hasMoss = mossy && upward > 0.35 && y + patch * 0.14 > 0.12;
    const shade = 0.86 + 0.11 * upward + patch * 0.035 + fineGrain * 0.018;
    const color = hasMoss ? MOSS_COLOR : stone;
    const mineralTint = darkInclusion ? -0.055 : fineGrain > 0.9 ? 0.035 : 0;
    colors[vertex * 4] = Math.max(0, color[0] * shade + mineralTint);
    colors[vertex * 4 + 1] = Math.max(0, color[1] * shade + mineralTint * 0.93);
    colors[vertex * 4 + 2] = Math.max(0, color[2] * shade + mineralTint * 0.78);
    colors[vertex * 4 + 3] = 1;
  }
  // The builder's buffers are not updatable, so an in-place update would be
  // silently ignored and the stone would keep the undeformed sphere's normals.
  // Replacing the buffers uploads the deformed geometry and its real normals.
  rock.setVerticesData(VertexBuffer.PositionKind, positions);
  rock.setVerticesData(VertexBuffer.NormalKind, normals);
  rock.setVerticesData(VertexBuffer.ColorKind, colors);
  rock.useVertexColors = true;
  rock.hasVertexAlpha = false;
  rock.refreshBoundingInfo({ updatePositionsArray: false });
  return rock;
}

/**
 * Flattens the stone against several random half-spaces, the way a block
 * fractures along joints. Every vertex outside a plane is projected onto it,
 * so each plane leaves one flat facet bounded by hard creases. Duplicated
 * flat-shaded vertices share positions and therefore move identically, which
 * keeps the surface watertight. Returns the planes used.
 */
function clipToFracturePlanes(
  positions: Float32Array | number[],
  random: () => number,
): FracturePlane[] {
  const planes: FracturePlane[] = [];
  const planeCount = 5 + Math.floor(random() * 3);
  for (let plane = 0; plane < planeCount; plane++) {
    // Uniform direction on the sphere, biased slightly away from the very top
    // so most stones still present a broad, sittable upper face.
    const azimuth = random() * Math.PI * 2;
    const elevation = Math.asin(random() * 2 - 1) * 0.85;
    const normalX = Math.cos(elevation) * Math.cos(azimuth);
    const normalY = Math.sin(elevation);
    const normalZ = Math.cos(elevation) * Math.sin(azimuth);
    const distance = 0.55 + random() * 0.3;
    planes.push({ normalX, normalY, normalZ, distance });
    for (let index = 0; index < positions.length; index += 3) {
      const excess = positions[index] * normalX +
        positions[index + 1] * normalY +
        positions[index + 2] * normalZ - distance;
      if (excess <= 0) continue;
      positions[index] -= normalX * excess;
      positions[index + 1] -= normalY * excess;
      positions[index + 2] -= normalZ * excess;
    }
  }
  return planes;
}

interface FracturePlane {
  normalX: number;
  normalY: number;
  normalZ: number;
  distance: number;
}

/** How far off a fracture plane a projected vertex may drift and still count as on it. */
const FACET_TOLERANCE = 1e-4;

/**
 * Per-face vertices give every triangle its own normal, which turns the
 * rounded body of a stone into a low-poly gem. Triangles lying wholly on one
 * fracture plane keep their face normal so the crease stays hard; every other
 * vertex takes the average normal of all coincident vertices, restoring the
 * smooth curvature between facets. With no planes this is plain smoothing.
 */
function smoothNormalsOffFacets(
  positions: Float32Array | number[],
  indices: Int32Array | Uint32Array | Uint16Array | number[],
  normals: Float32Array,
  planes: FracturePlane[],
): void {
  const vertexCount = positions.length / 3;
  const sums = new Map<string, [number, number, number]>();
  const keyOf = (vertex: number): string =>
    `${positions[vertex * 3].toFixed(5)},${positions[vertex * 3 + 1].toFixed(5)},${
      positions[vertex * 3 + 2].toFixed(5)}`;
  const keys: string[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const key = keyOf(vertex);
    keys.push(key);
    const sum = sums.get(key) ?? [0, 0, 0];
    sum[0] += normals[vertex * 3];
    sum[1] += normals[vertex * 3 + 1];
    sum[2] += normals[vertex * 3 + 2];
    sums.set(key, sum);
  }
  const liesOn = (vertex: number, plane: FracturePlane): boolean =>
    Math.abs(
      positions[vertex * 3] * plane.normalX +
      positions[vertex * 3 + 1] * plane.normalY +
      positions[vertex * 3 + 2] * plane.normalZ - plane.distance,
    ) < FACET_TOLERANCE;
  for (let face = 0; face < indices.length; face += 3) {
    const a = indices[face];
    const b = indices[face + 1];
    const c = indices[face + 2];
    const onOneFacet = planes.some(
      (plane) => liesOn(a, plane) && liesOn(b, plane) && liesOn(c, plane),
    );
    if (onOneFacet) continue;
    for (const vertex of [a, b, c]) {
      const [x, y, z] = sums.get(keys[vertex])!;
      const length = Math.hypot(x, y, z) || 1;
      normals[vertex * 3] = x / length;
      normals[vertex * 3 + 1] = y / length;
      normals[vertex * 3 + 2] = z / length;
    }
  }
}
