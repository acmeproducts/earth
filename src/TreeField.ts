import {
  Camera,
  Matrix,
  Mesh,
  Scene,
  ShaderMaterial,
  TransformNode,
  Vector2,
  Vector3,
  VertexData,
} from "@babylonjs/core";
import { isTerrainFootprintAbove, sceneToLonLat, sampleElevation } from "./Geo";
import { TerrainResult } from "./TerrainTiles";
import { createTreeModels, getTreeImpostorAssets, TREE_IMPOSTOR_FACES, TreeImpostorAssets } from "./TreeImpostor";
import {
  createVegetationFieldResult,
  VegetationFieldResult,
  VegetationRenderMode,
} from "./VegetationField";
import { LandCoverClass, WorldCover } from "./WorldCover";

export type TreeFieldResult = VegetationFieldResult;

export interface TreeImpostorPrototype {
  root: TransformNode;
  mesh: Mesh;
  assets: TreeImpostorAssets;
  captureSize: number;
}

interface TreeFieldOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  seed?: number;
  spacingMeters?: number;
  occupancy?: number;
  edgeOccupancy?: number;
  fullDensityDepthMeters?: number;
  waterLineMeters?: number;
  landCover?: WorldCover;
  renderMode?: VegetationRenderMode;
}

export const impostorVertexShader = `
precision highp float;
attribute vec3 position;
uniform mat4 viewProjection;
uniform vec3 cameraPosition;
uniform float captureCenterY;
#include<instancesDeclaration>
varying vec3 vLocalPosition;
varying vec3 vViewDirection;

void main(void) {
  #include<instancesVertex>
  vec4 worldPosition = finalWorld * vec4(position, 1.0);
  vec3 center = (finalWorld * vec4(0.0, captureCenterY, 0.0, 1.0)).xyz;
  vec3 axisX = normalize(finalWorld[0].xyz);
  vec3 axisY = normalize(finalWorld[1].xyz);
  vec3 axisZ = normalize(finalWorld[2].xyz);
  vec3 worldViewDirection = cameraPosition - center;

  vLocalPosition = position - vec3(0.0, captureCenterY, 0.0);
  vViewDirection = vec3(
    dot(worldViewDirection, axisX),
    dot(worldViewDirection, axisY),
    dot(worldViewDirection, axisZ)
  );
  gl_Position = viewProjection * worldPosition;
}`;

export const impostorFragmentShader = `
precision highp float;
varying vec3 vLocalPosition;
varying vec3 vViewDirection;
uniform sampler2D atlas0;
uniform sampler2D atlas1;
uniform sampler2D atlas2;
uniform sampler2D atlas3;
uniform sampler2D atlas4;
uniform sampler2D atlas5;
uniform vec2 gridDimensions;
uniform float tileInset;
uniform float captureSize;
uniform float cameraOrthographic;

vec4 atlasSample(float face, vec2 uv) {
  if (face < 0.5) return texture2D(atlas0, uv);
  if (face < 1.5) return texture2D(atlas1, uv);
  if (face < 2.5) return texture2D(atlas2, uv);
  if (face < 3.5) return texture2D(atlas3, uv);
  if (face < 4.5) return texture2D(atlas4, uv);
  return texture2D(atlas5, uv);
}

vec4 frame(float face, vec2 tile, vec2 imageUV) {
  vec2 localUV = mix(vec2(tileInset), vec2(1.0 - tileInset), imageUV);
  return atlasSample(face, (tile + localUV) / gridDimensions);
}

float bayer4(vec2 pixel) {
  vec2 p = mod(floor(pixel), 4.0);
  float index = p.x + p.y * 4.0;
  if (index < 0.5) return 0.0 / 16.0;
  if (index < 1.5) return 8.0 / 16.0;
  if (index < 2.5) return 2.0 / 16.0;
  if (index < 3.5) return 10.0 / 16.0;
  if (index < 4.5) return 12.0 / 16.0;
  if (index < 5.5) return 4.0 / 16.0;
  if (index < 6.5) return 14.0 / 16.0;
  if (index < 7.5) return 6.0 / 16.0;
  if (index < 8.5) return 3.0 / 16.0;
  if (index < 9.5) return 11.0 / 16.0;
  if (index < 10.5) return 1.0 / 16.0;
  if (index < 11.5) return 9.0 / 16.0;
  if (index < 12.5) return 15.0 / 16.0;
  if (index < 13.5) return 7.0 / 16.0;
  if (index < 14.5) return 13.0 / 16.0;
  return 5.0 / 16.0;
}

void main(void) {
  vec3 direction = normalize(vViewDirection);
  vec3 absoluteDirection = abs(direction);
  vec3 faceNormal;
  float face;
  vec3 faceRight;
  vec3 faceUp;

  if (absoluteDirection.x >= absoluteDirection.y && absoluteDirection.x >= absoluteDirection.z) {
    if (direction.x >= 0.0) {
      face = 0.0; faceNormal = vec3(1.0, 0.0, 0.0); faceRight = vec3(0.0, 0.0, -1.0); faceUp = vec3(0.0, 1.0, 0.0);
    } else {
      face = 1.0; faceNormal = vec3(-1.0, 0.0, 0.0); faceRight = vec3(0.0, 0.0, 1.0); faceUp = vec3(0.0, 1.0, 0.0);
    }
  } else if (absoluteDirection.y >= absoluteDirection.z) {
    if (direction.y >= 0.0) {
      face = 2.0; faceNormal = vec3(0.0, 1.0, 0.0); faceRight = vec3(1.0, 0.0, 0.0); faceUp = vec3(0.0, 0.0, -1.0);
    } else {
      face = 3.0; faceNormal = vec3(0.0, -1.0, 0.0); faceRight = vec3(1.0, 0.0, 0.0); faceUp = vec3(0.0, 0.0, 1.0);
    }
  } else {
    if (direction.z >= 0.0) {
      face = 4.0; faceNormal = vec3(0.0, 0.0, 1.0); faceRight = vec3(1.0, 0.0, 0.0); faceUp = vec3(0.0, 1.0, 0.0);
    } else {
      face = 5.0; faceNormal = vec3(0.0, 0.0, -1.0); faceRight = vec3(-1.0, 0.0, 0.0); faceUp = vec3(0.0, 1.0, 0.0);
    }
  }

  float denominator = max(0.0001, dot(direction, faceNormal));
  vec2 projected = vec2(dot(direction, faceRight), dot(direction, faceUp)) / denominator;
  vec2 samplePosition = clamp((projected + 1.0) * 0.5, 0.0, 1.0) * (gridDimensions - 1.0);
  vec3 projectedPosition = vLocalPosition;
  if (cameraOrthographic < 0.5) {
    vec3 cameraOffset = vViewDirection;
    vec3 ray = vLocalPosition - cameraOffset;
    float rayDenominator = dot(ray, direction);
    if (abs(rayDenominator) < 0.0001) discard;
    float distanceAlongRay = -dot(cameraOffset, direction) / rayDenominator;
    projectedPosition = cameraOffset + ray * distanceAlongRay;
  }

  vec3 billboardRight = normalize(cross(direction, faceUp));
  vec3 billboardUp = normalize(cross(billboardRight, direction));
  vec2 imageUV = vec2(
    0.5 + dot(projectedPosition, billboardRight) / captureSize,
    0.5 - dot(projectedPosition, billboardUp) / captureSize
  );
  if (any(lessThan(imageUV, vec2(0.0))) || any(greaterThan(imageUV, vec2(1.0)))) discard;

  vec2 low = floor(samplePosition);
  vec2 high = min(low + 1.0, gridDimensions - 1.0);
  vec2 blend = fract(samplePosition);
  vec4 weights = vec4(
    (1.0 - blend.x) * (1.0 - blend.y),
    blend.x * (1.0 - blend.y),
    (1.0 - blend.x) * blend.y,
    blend.x * blend.y
  );
  float choice = bayer4(gl_FragCoord.xy);
  vec4 color;
  if (choice < weights.x) {
    color = frame(face, vec2(low.x, low.y), imageUV);
  } else if (choice < weights.x + weights.y) {
    color = frame(face, vec2(high.x, low.y), imageUV);
  } else if (choice < weights.x + weights.y + weights.z) {
    color = frame(face, vec2(low.x, high.y), imageUV);
  } else {
    color = frame(face, vec2(high.x, high.y), imageUV);
  }

  float alphaChoice = bayer4(gl_FragCoord.xy + vec2(1.0, 2.0));
  if (color.a <= alphaChoice) discard;
  vec3 straightColor = color.rgb / max(color.a, 1.0 / 255.0);
  gl_FragColor = vec4(straightColor, 1.0);
}`;

/** Creates fixed cube impostors within ESA WorldCover tree-cover cells. */
export async function createTreeField(
  scene: Scene,
  terrain: TerrainResult,
  options: TreeFieldOptions,
): Promise<TreeFieldResult> {
  const {
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x4f534c4f,
    spacingMeters = 3.5,
    occupancy = 0.78,
    edgeOccupancy = 0.12,
    fullDensityDepthMeters = 45,
    waterLineMeters = 0,
    landCover,
    renderMode = "impostors",
  } = options;
  const treeHeight = 11 / metersPerUnit;
  const prototype = await createTreeImpostorPrototype(scene, treeHeight, "treeField");
  const { root, mesh: tree, captureSize } = prototype;
  const modelMeshes = await createTreeModels(scene, treeHeight);
  modelMeshes.forEach((mesh) => { mesh.parent = root; });
  const modelMaterials = new Set(modelMeshes.map((mesh) => mesh.material).filter((material) => material !== null));
  root.onDisposeObservable.add(() => {
    modelMaterials.forEach((material) => material.dispose(true, true));
  });

  const random = mulberry32(seed);
  const spacing = spacingMeters / metersPerUnit;
  const columns = Math.max(1, Math.floor(meshWidth / spacing));
  const rows = Math.max(1, Math.floor(meshDepth / spacing));
  const cellWidth = meshWidth / columns;
  const cellDepth = meshDepth / rows;
  const maximumHalfWidth = captureSize * 0.55;
  const matrices: Matrix[] = [];

  if (landCover && terrain.bounds) {
    const forestMask = new Uint8Array(rows * columns);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const x = -meshWidth / 2 + (column + 0.5) * cellWidth;
        const z = meshDepth / 2 - (row + 0.5) * cellDepth;
        const { lon, lat } = sceneToLonLat(x, z, terrain.bounds, meshWidth, meshDepth);
        const cover = landCover.sample(lon, lat);
        if (cover === LandCoverClass.TreeCover || cover === LandCoverClass.Mangrove) {
          forestMask[row * columns + column] = 1;
        }
      }
    }

    const edgeDistances = distanceInsideMask(
      forestMask,
      columns,
      rows,
      cellWidth * metersPerUnit,
      cellDepth * metersPerUnit,
    );

    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const index = row * columns + column;
        if (!forestMask[index]) continue;

        const x = -meshWidth / 2 + (column + 0.2 + random() * 0.6) * cellWidth;
        const z = meshDepth / 2 - (row + 0.2 + random() * 0.6) * cellDepth;
        const elevation = sampleElevation(terrain, x, z, meshWidth, meshDepth);
        if (!isTerrainFootprintAbove(
          terrain,
          x,
          z,
          maximumHalfWidth,
          maximumHalfWidth,
          meshWidth,
          meshDepth,
          waterLineMeters,
        )) continue;

        const depth = Math.min(1, edgeDistances[index] / fullDensityDepthMeters);
        const interiorWeight = depth * depth * (3 - 2 * depth);
        const localOccupancy = edgeOccupancy + (occupancy - edgeOccupancy) * interiorWeight;
        if (random() > localOccupancy) continue;

        const heightScale = 0.75 + random() * 0.5;
        const widthScale = 0.75 + random() * 0.35;
        const yaw = (random() - 0.5) * Math.PI * 2;
        const pitch = (random() - 0.5) * 0.08;
        const roll = (random() - 0.5) * 0.08;
        matrices.push(
          Matrix.Compose(
            new Vector3(widthScale, heightScale, widthScale),
            new Vector3(pitch, yaw, roll).toQuaternion(),
            new Vector3(x, elevation / metersPerUnit, z),
          ),
        );
      }
    }
  }

  const matrixData = new Float32Array(matrices.length * 16);
  matrices.forEach((matrix, index) => matrix.copyToArray(matrixData, index * 16));
  return createVegetationFieldResult(
    root,
    [tree],
    modelMeshes,
    matrixData,
    metersPerUnit,
    renderMode,
  );
}

/** Builds the same fixed cube and material used by every forest instance. */
export async function createTreeImpostorPrototype(
  scene: Scene,
  treeHeight: number,
  rootName = "treeImpostorPrototype",
): Promise<TreeImpostorPrototype> {
  const root = new TransformNode(rootName, scene);
  const assets = await getTreeImpostorAssets(scene);
  const captureSize = treeHeight * (assets.captureDiameter / assets.sourceHeight);
  const tree = createImpostorCube(scene, captureSize, treeHeight / 2);
  tree.parent = root;
  tree.isPickable = false;

  const material = createImpostorMaterial(
    scene,
    assets,
    treeHeight,
    captureSize,
    "treeImpostorMaterial",
  );
  root.onDisposeObservable.add(() => material.dispose(false, false));
  tree.material = material;
  return { root, mesh: tree, assets, captureSize };
}

export function createImpostorMaterial(
  scene: Scene,
  assets: TreeImpostorAssets,
  renderHeight: number,
  captureSize: number,
  name: string,
): ShaderMaterial {
  const material = new ShaderMaterial(
    name,
    scene,
    { vertexSource: impostorVertexShader, fragmentSource: impostorFragmentShader },
    {
      attributes: ["position"],
      uniforms: ["world", "viewProjection", "cameraPosition", "captureCenterY", "captureSize", "gridDimensions", "tileInset", "cameraOrthographic"],
      samplers: ["atlas0", "atlas1", "atlas2", "atlas3", "atlas4", "atlas5"],
      needAlphaBlending: false,
    },
  );
  material.backFaceCulling = true;
  material.setFloat("captureCenterY", renderHeight / 2);
  material.setFloat("captureSize", captureSize);
  material.setVector2("gridDimensions", new Vector2(assets.gridWidth, assets.gridHeight));
  material.setFloat("tileInset", 0.5 / assets.resolution);
  material.setFloat("cameraOrthographic", 0);
  assets.textures.forEach((texture, index) => material.setTexture(`atlas${index}`, texture));
  material.onBindObservable.add(() => {
    material.setFloat(
      "cameraOrthographic",
      scene.activeCamera?.mode === Camera.ORTHOGRAPHIC_CAMERA ? 1 : 0,
    );
  });
  return material;
}

export function createImpostorCube(
  scene: Scene,
  size: number,
  centerY: number,
  name = "treeImpostors",
): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const half = size / 2;

  TREE_IMPOSTOR_FACES.forEach((face, faceIndex) => {
    const faceCenter = face.normal.scale(half).add(new Vector3(0, centerY, 0));
    const corners = [
      faceCenter.subtract(face.right.scale(half)).subtract(face.up.scale(half)),
      faceCenter.add(face.right.scale(half)).subtract(face.up.scale(half)),
      faceCenter.add(face.right.scale(half)).add(face.up.scale(half)),
      faceCenter.subtract(face.right.scale(half)).add(face.up.scale(half)),
    ];
    for (const corner of corners) {
      positions.push(corner.x, corner.y, corner.z);
      normals.push(face.normal.x, face.normal.y, face.normal.z);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    const vertex = faceIndex * 4;
    indices.push(vertex, vertex + 2, vertex + 1, vertex, vertex + 3, vertex + 2);
  });

  const tree = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.indices = indices;
  data.applyToMesh(tree);
  return tree;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function distanceInsideMask(
  mask: Uint8Array,
  width: number,
  height: number,
  horizontalStep: number,
  verticalStep: number,
): Float32Array {
  const distance = new Float32Array(mask.length);
  const diagonalStep = Math.hypot(horizontalStep, verticalStep);
  const boundaryDistance = Math.min(horizontalStep, verticalStep) / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      distance[index] = mask[index] ? Infinity : 0;
      if (mask[index] && (x === 0 || x === width - 1 || y === 0 || y === height - 1)) {
        distance[index] = boundaryDistance;
      }
    }
  }

  distancePass(distance, width, height, horizontalStep, verticalStep, diagonalStep, false);
  distancePass(distance, width, height, horizontalStep, verticalStep, diagonalStep, true);
  return distance;
}

function distancePass(
  distance: Float32Array,
  width: number,
  height: number,
  horizontalStep: number,
  verticalStep: number,
  diagonalStep: number,
  reverse: boolean,
): void {
  for (let row = 0; row < height; row++) {
    const y = reverse ? height - 1 - row : row;
    for (let column = 0; column < width; column++) {
      const x = reverse ? width - 1 - column : column;
      const index = y * width + x;
      const horizontal = x + (reverse ? 1 : -1);
      const vertical = y + (reverse ? 1 : -1);

      if (horizontal >= 0 && horizontal < width) {
        distance[index] = Math.min(distance[index], distance[y * width + horizontal] + horizontalStep);
      }
      if (vertical >= 0 && vertical < height) {
        distance[index] = Math.min(distance[index], distance[vertical * width + x] + verticalStep);
        if (horizontal >= 0 && horizontal < width) {
          distance[index] = Math.min(distance[index], distance[vertical * width + horizontal] + diagonalStep);
        }
        const otherHorizontal = x + (reverse ? -1 : 1);
        if (otherHorizontal >= 0 && otherHorizontal < width) {
          distance[index] = Math.min(
            distance[index],
            distance[vertical * width + otherHorizontal] + diagonalStep,
          );
        }
      }
    }
  }
}
