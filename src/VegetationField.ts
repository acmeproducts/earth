import { Mesh, TransformNode, Vector3 } from "@babylonjs/core";

export type VegetationRenderMode = "impostors" | "auto" | "models";

const LOD_TRANSITION_WIDTH_METERS = 40;
const IMPOSTOR_SORT_DISTANCE_METERS = 2;

export interface VegetationFieldResult {
  root: TransformNode;
  meshes: Mesh[];
  impostorMeshes: Mesh[];
  modelMeshes: Mesh[];
  instanceMatrices: Float32Array;
  count: number;
  setRenderMode(mode: VegetationRenderMode): void;
  setAmbientOcclusionEnabled(enabled: boolean): void;
  updateLod(cameraPosition: Vector3, distanceMeters: number): void;
}

export function createVegetationFieldResult(
  root: TransformNode,
  impostorMeshes: Mesh[],
  modelMeshes: Mesh[],
  matrices: Float32Array,
  metersPerUnit: number,
  initialMode: VegetationRenderMode,
  instanceOcclusion?: Float32Array,
  instanceColors?: Float32Array,
): VegetationFieldResult {
  const count = matrices.length / 16;
  if (instanceOcclusion && instanceOcclusion.length !== count) {
    throw new Error("Instance occlusion count must match the vegetation matrix count.");
  }
  if (instanceColors && instanceColors.length !== count * 3) {
    throw new Error("Instance color count must match the vegetation matrix count.");
  }
  const impostorMatrices = new Float32Array(matrices.length);
  const modelMatrices = new Float32Array(matrices.length);
  const sourceOcclusion = instanceOcclusion ?? new Float32Array(count);
  const activeSourceOcclusion = new Float32Array(count);
  const impostorOcclusion = new Float32Array(count);
  const modelOcclusion = new Float32Array(count);
  const sourceColors = instanceColors ?? new Float32Array(count * 3).fill(1);
  const impostorColors = new Float32Array(sourceColors.length);
  const modelColors = new Float32Array(sourceColors.length);
  const impostorLodBlend = new Float32Array(count);
  const modelLodBlend = new Float32Array(count);
  const sourceLodBlend = new Float32Array(count);
  impostorMatrices.set(matrices);
  modelMatrices.set(matrices);
  activeSourceOcclusion.set(sourceOcclusion);
  impostorOcclusion.set(sourceOcclusion);
  modelOcclusion.set(sourceOcclusion);
  impostorColors.set(sourceColors);
  modelColors.set(sourceColors);
  modelLodBlend.fill(1);

  initializeMeshes(impostorMeshes, impostorMatrices, impostorOcclusion, impostorColors, impostorLodBlend);
  initializeMeshes(modelMeshes, modelMatrices, modelOcclusion, modelColors, modelLodBlend);

  let mode = initialMode;
  let lastCameraPosition: Vector3 | undefined;
  let lastImpostorSortPosition: Vector3 | undefined;
  let lastDistanceMeters = 10;
  let ambientOcclusionEnabled = true;
  const allInstanceIndices = Array.from({ length: count }, (_, index) => index);

  const setCounts = (impostorCount: number, modelCount: number): void => {
    setMeshCount(impostorMeshes, impostorCount);
    setMeshCount(modelMeshes, modelCount);
  };

  const setRenderMode = (mode: VegetationRenderMode): void => {
    if (mode === "impostors") {
      impostorLodBlend.fill(0);
      if (lastCameraPosition) {
        writeFrontToBackInstances(
          impostorMatrices,
          impostorOcclusion,
          matrices,
          activeSourceOcclusion,
          allInstanceIndices,
          lastCameraPosition,
          impostorColors,
          sourceColors,
          impostorLodBlend,
          impostorLodBlend,
        );
        lastImpostorSortPosition = lastCameraPosition.clone();
      } else {
        impostorMatrices.set(matrices);
        impostorOcclusion.set(activeSourceOcclusion);
        impostorColors.set(sourceColors);
      }
      setCounts(count, 0);
      updateMeshBuffers(impostorMeshes, true);
    } else if (mode === "models") {
      modelMatrices.set(matrices);
      modelOcclusion.set(activeSourceOcclusion);
      modelColors.set(sourceColors);
      modelLodBlend.fill(1);
      setCounts(0, count);
      updateMeshBuffers(modelMeshes, true);
    } else if (lastCameraPosition) {
      updateAutoLod(lastCameraPosition, lastDistanceMeters);
    } else {
      impostorMatrices.set(matrices);
      impostorOcclusion.set(activeSourceOcclusion);
      impostorColors.set(sourceColors);
      setCounts(count, 0);
      updateMeshBuffers(impostorMeshes, true);
    }
  };

  const updateAutoLod = (cameraPosition: Vector3, distanceMeters: number): void => {
    const transitionWidthMeters = Math.min(LOD_TRANSITION_WIDTH_METERS, distanceMeters);
    const innerDistance = (distanceMeters - transitionWidthMeters / 2) / metersPerUnit;
    const outerDistance = (distanceMeters + transitionWidthMeters / 2) / metersPerUnit;
    const innerDistanceSquared = innerDistance * innerDistance;
    const outerDistanceSquared = outerDistance * outerDistance;
    let impostorCount = 0;
    let modelCount = 0;
    const impostorIndices: number[] = [];

    for (let matrixOffset = 0; matrixOffset < matrices.length; matrixOffset += 16) {
      const dx = matrices[matrixOffset + 12] - cameraPosition.x;
      const dy = matrices[matrixOffset + 13] - cameraPosition.y;
      const dz = matrices[matrixOffset + 14] - cameraPosition.z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      let modelWeight: number;
      if (distanceSquared <= innerDistanceSquared) {
        modelWeight = 1;
      } else if (distanceSquared >= outerDistanceSquared) {
        modelWeight = 0;
      } else {
        const distance = Math.sqrt(distanceSquared);
        const linearBlend = (outerDistance - distance) / (outerDistance - innerDistance);
        modelWeight = linearBlend * linearBlend * (3 - 2 * linearBlend);
      }
      const instanceIndex = matrixOffset / 16;
      sourceLodBlend[instanceIndex] = modelWeight;
      if (modelWeight > 0) {
        copyMatrix(modelMatrices, modelCount * 16, matrices, matrixOffset);
        copyColor(modelColors, modelCount * 3, sourceColors, matrixOffset / 16 * 3);
        modelOcclusion[modelCount] = activeSourceOcclusion[instanceIndex];
        modelLodBlend[modelCount++] = modelWeight;
      }
    }

    const sortDistanceSquared = (IMPOSTOR_SORT_DISTANCE_METERS / metersPerUnit) ** 2;
    if (!lastImpostorSortPosition || Vector3.DistanceSquared(
      cameraPosition,
      lastImpostorSortPosition,
    ) >= sortDistanceSquared) {
      sortInstanceIndicesFrontToBack(allInstanceIndices, matrices, cameraPosition);
      lastImpostorSortPosition = cameraPosition.clone();
    }
    for (const instanceIndex of allInstanceIndices) {
      if (sourceLodBlend[instanceIndex] >= 1) continue;
      impostorIndices.push(instanceIndex);
      impostorCount++;
    }

    writeFrontToBackInstances(
      impostorMatrices,
      impostorOcclusion,
      matrices,
      activeSourceOcclusion,
      impostorIndices,
      cameraPosition,
      impostorColors,
      sourceColors,
      impostorLodBlend,
      sourceLodBlend,
      false,
    );

    setCounts(impostorCount, modelCount);
    updateMeshBuffers(impostorMeshes, true);
    updateMeshBuffers(modelMeshes, true);
  };

  const updateLod = (cameraPosition: Vector3, distanceMeters: number): void => {
    if (
      lastCameraPosition &&
      Vector3.DistanceSquared(cameraPosition, lastCameraPosition) < 1e-12 &&
      distanceMeters === lastDistanceMeters
    ) return;
    lastCameraPosition = cameraPosition.clone();
    lastDistanceMeters = distanceMeters;
    if (mode === "auto") {
      updateAutoLod(cameraPosition, distanceMeters);
    } else if (
      mode === "impostors" &&
      (!lastImpostorSortPosition || Vector3.DistanceSquared(
        cameraPosition,
        lastImpostorSortPosition,
      ) >= (IMPOSTOR_SORT_DISTANCE_METERS / metersPerUnit) ** 2)
    ) {
      writeFrontToBackInstances(
        impostorMatrices,
        impostorOcclusion,
        matrices,
        activeSourceOcclusion,
        allInstanceIndices,
        cameraPosition,
        impostorColors,
        sourceColors,
        impostorLodBlend,
        impostorLodBlend,
      );
      lastImpostorSortPosition = cameraPosition.clone();
      updateMeshBuffers(impostorMeshes, true);
    }
  };

  const applyRenderMode = (nextMode: VegetationRenderMode): void => {
    mode = nextMode;
    setRenderMode(nextMode);
  };

  const setAmbientOcclusionEnabled = (enabled: boolean): void => {
    if (ambientOcclusionEnabled === enabled) return;
    ambientOcclusionEnabled = enabled;
    if (enabled) activeSourceOcclusion.set(sourceOcclusion);
    else activeSourceOcclusion.fill(0);
    setRenderMode(mode);
  };

  applyRenderMode(initialMode);
  return {
    root,
    meshes: [...impostorMeshes, ...modelMeshes],
    impostorMeshes,
    modelMeshes,
    instanceMatrices: matrices,
    count,
    setRenderMode: applyRenderMode,
    setAmbientOcclusionEnabled,
    updateLod,
  };
}

/** Approximates sky occlusion from neighboring vegetation instances. */
export function computeVegetationOcclusion(
  matrices: Float32Array,
  radius: number,
  additionalOccluders: readonly Float32Array[] = [],
): Float32Array {
  const count = matrices.length / 16;
  const result = new Float32Array(count);
  if (count === 0 || radius <= 0) return result;

  interface Occluder {
    matrices: Float32Array;
    index: number;
  }
  const buckets = new Map<string, Occluder[]>();
  const bucketCoordinate = (value: number): number => Math.floor(value / radius);
  const bucketKey = (x: number, z: number): string => `${x}:${z}`;

  for (const occluderMatrices of [matrices, ...additionalOccluders]) {
    const occluderCount = occluderMatrices.length / 16;
    for (let index = 0; index < occluderCount; index++) {
      const offset = index * 16;
      const key = bucketKey(
        bucketCoordinate(occluderMatrices[offset + 12]),
        bucketCoordinate(occluderMatrices[offset + 14]),
      );
      const bucket = buckets.get(key);
      const occluder = { matrices: occluderMatrices, index };
      if (bucket) bucket.push(occluder);
      else buckets.set(key, [occluder]);
    }
  }

  const radiusSquared = radius * radius;
  for (let index = 0; index < count; index++) {
    const offset = index * 16;
    const x = matrices[offset + 12];
    const z = matrices[offset + 14];
    const centerX = bucketCoordinate(x);
    const centerZ = bucketCoordinate(z);
    let crowding = 0;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = buckets.get(bucketKey(centerX + dx, centerZ + dz));
        if (!bucket) continue;
        for (const occluder of bucket) {
          if (occluder.matrices === matrices && occluder.index === index) continue;
          const neighborOffset = occluder.index * 16;
          const offsetX = occluder.matrices[neighborOffset + 12] - x;
          const offsetZ = occluder.matrices[neighborOffset + 14] - z;
          const distanceSquared = offsetX * offsetX + offsetZ * offsetZ;
          if (distanceSquared >= radiusSquared) continue;
          const proximity = 1 - Math.sqrt(distanceSquared) / radius;
          crowding += proximity * proximity;
        }
      }
    }

    result[index] = Math.min(0.7, 1 - Math.exp(-crowding * 0.32));
  }

  return result;
}

function writeFrontToBackInstances(
  destinationMatrices: Float32Array,
  destinationOcclusion: Float32Array,
  sourceMatrices: Float32Array,
  sourceOcclusion: Float32Array,
  instanceIndices: number[],
  cameraPosition: Vector3,
  destinationColors?: Float32Array,
  sourceColors?: Float32Array,
  destinationLodBlend?: Float32Array,
  sourceLodBlend?: Float32Array,
  sortInstances = true,
): void {
  if (sortInstances) {
    sortInstanceIndicesFrontToBack(instanceIndices, sourceMatrices, cameraPosition);
  }
  for (let destinationIndex = 0; destinationIndex < instanceIndices.length; destinationIndex++) {
    const sourceIndex = instanceIndices[destinationIndex];
    copyMatrix(
      destinationMatrices,
      destinationIndex * 16,
      sourceMatrices,
      sourceIndex * 16,
    );
    destinationOcclusion[destinationIndex] = sourceOcclusion[sourceIndex];
    if (destinationColors && sourceColors) {
      copyColor(destinationColors, destinationIndex * 3, sourceColors, sourceIndex * 3);
    }
    if (destinationLodBlend && sourceLodBlend) {
      destinationLodBlend[destinationIndex] = sourceLodBlend[sourceIndex];
    }
  }
}

function sortInstanceIndicesFrontToBack(
  instanceIndices: number[],
  matrices: Float32Array,
  cameraPosition: Vector3,
): void {
  const distances = new Float64Array(matrices.length / 16);
  for (const instanceIndex of instanceIndices) {
    distances[instanceIndex] = instanceDistanceSquared(matrices, instanceIndex, cameraPosition);
  }
  instanceIndices.sort((left, right) => distances[left] - distances[right]);
}

function instanceDistanceSquared(
  matrices: Float32Array,
  instanceIndex: number,
  cameraPosition: Vector3,
): number {
  const offset = instanceIndex * 16;
  const dx = matrices[offset + 12] - cameraPosition.x;
  const dy = matrices[offset + 13] - cameraPosition.y;
  const dz = matrices[offset + 14] - cameraPosition.z;
  return dx * dx + dy * dy + dz * dz;
}

function copyMatrix(
  destination: Float32Array,
  destinationOffset: number,
  source: Float32Array,
  sourceOffset: number,
): void {
  for (let element = 0; element < 16; element++) {
    destination[destinationOffset + element] = source[sourceOffset + element];
  }
}

function copyColor(
  destination: Float32Array,
  destinationOffset: number,
  source: Float32Array,
  sourceOffset: number,
): void {
  destination[destinationOffset] = source[sourceOffset];
  destination[destinationOffset + 1] = source[sourceOffset + 1];
  destination[destinationOffset + 2] = source[sourceOffset + 2];
}

function initializeMeshes(
  meshes: Mesh[],
  matrices: Float32Array,
  instanceOcclusion?: Float32Array,
  instanceColors?: Float32Array,
  instanceLodBlend?: Float32Array,
): void {
  for (const mesh of meshes) {
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
    if (instanceOcclusion) {
      mesh.thinInstanceSetBuffer("instanceOcclusion", instanceOcclusion, 1, false);
    }
    if (instanceColors) {
      mesh.thinInstanceSetBuffer("vegetationColor", instanceColors, 3, false);
    }
    if (instanceLodBlend) {
      mesh.thinInstanceSetBuffer("instanceLodBlend", instanceLodBlend, 1, false);
    }
    mesh.thinInstanceRefreshBoundingInfo(true);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.freezeWorldMatrix();
  }
}

function updateMeshBuffers(meshes: Mesh[], updateOcclusion = false): void {
  meshes.forEach((mesh) => {
    mesh.thinInstanceBufferUpdated("matrix");
    if (updateOcclusion) {
      mesh.thinInstanceBufferUpdated("instanceOcclusion");
      mesh.thinInstanceBufferUpdated("vegetationColor");
      mesh.thinInstanceBufferUpdated("instanceLodBlend");
    }
  });
}

function setMeshCount(meshes: Mesh[], count: number): void {
  for (const mesh of meshes) {
    mesh.thinInstanceCount = count;
    mesh.setEnabled(count > 0);
  }
}
