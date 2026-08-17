import { Mesh, TransformNode, Vector3 } from "@babylonjs/core";
import { SpatialReferenceGrid } from "./SpatialReferenceGrid";

export type VegetationRenderMode = "impostors" | "auto" | "models";

/** Narrow enough to keep the movement-time transition working set small. */
const LOD_TRANSITION_WIDTH_METERS = 20;

export interface ImpostorLodRange {
  /** Full-to-reduced impostor transition start, in scene units. */
  nearDistance: number;
  /** Full-to-reduced impostor transition end, in scene units. */
  farDistance: number;
  forceLowest?: boolean;
}

export interface VegetationLodDebugStats {
  totalInstances: number;
  updates: number;
  processedInstances: number;
  peakProcessedInstances: number;
  currentGridCandidates: number;
  currentTransitionInstances: number;
  membershipChanges: number;
  fullRebuilds: number;
}

export interface VegetationFieldResult {
  root: TransformNode;
  meshes: Mesh[];
  impostorMeshes: Mesh[];
  modelMeshes: Mesh[];
  instanceMatrices: Float32Array;
  count: number;
  setRenderMode(mode: VegetationRenderMode): void;
  setAmbientOcclusionEnabled(enabled: boolean): void;
  /** Updates packed model/impostor instances; true when the shadow map changed. */
  updateLod(cameraPosition: Vector3, distanceMeters: number): boolean;
  consumeLodDebugStats(): VegetationLodDebugStats;
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
  impostorLodRange?: ImpostorLodRange,
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
  const sourceImpostorLodBlend = new Float32Array(count);
  const impostorDetailLodBlend = new Float32Array(count);
  impostorMatrices.set(matrices);
  modelMatrices.set(matrices);
  activeSourceOcclusion.set(sourceOcclusion);
  impostorOcclusion.set(sourceOcclusion);
  modelOcclusion.set(sourceOcclusion);
  impostorColors.set(sourceColors);
  modelColors.set(sourceColors);
  modelLodBlend.fill(1);

  if (impostorLodRange?.forceLowest) sourceImpostorLodBlend.fill(1);
  impostorDetailLodBlend.set(sourceImpostorLodBlend);
  initializeMeshes(impostorMeshes, impostorMatrices, impostorOcclusion, impostorColors, impostorLodBlend, impostorDetailLodBlend);
  initializeMeshes(modelMeshes, modelMatrices, modelOcclusion, modelColors, modelLodBlend);

  let mode = initialMode;
  let lastCameraPosition: Vector3 | undefined;
  let lastDistanceMeters = 10;
  let ambientOcclusionEnabled = true;
  const allInstanceIndices = Array.from({ length: count }, (_, index) => index);
  let minimumInstanceY = Number.POSITIVE_INFINITY;
  let maximumInstanceY = Number.NEGATIVE_INFINITY;
  for (const index of allInstanceIndices) {
    minimumInstanceY = Math.min(minimumInstanceY, matrices[index * 16 + 13]);
    maximumInstanceY = Math.max(maximumInstanceY, matrices[index * 16 + 13]);
  }
  const spatialGrid = new SpatialReferenceGrid(
    allInstanceIndices.map((index) => ({
      x: matrices[index * 16 + 12],
      z: matrices[index * 16 + 14],
      value: index,
    })),
    Math.max(1 / metersPerUnit, Math.min(LOD_TRANSITION_WIDTH_METERS / metersPerUnit, 16 / metersPerUnit)),
  );
  let previousTransitionIndices = new Set<number>();
  let previousImpostorTransitionIndices = new Set<number>();
  const modelSlotBySource = new Int32Array(count).fill(-1);
  const impostorSlotBySource = new Int32Array(count).fill(-1);
  const modelSourceBySlot: number[] = [];
  const impostorSourceBySlot: number[] = [];
  let autoModelCount = 0;
  let autoImpostorCount = 0;
  let autoSlotsValid = false;
  const lodDebugStats: VegetationLodDebugStats = {
    totalInstances: count,
    updates: 0,
    processedInstances: 0,
    peakProcessedInstances: 0,
    currentGridCandidates: 0,
    currentTransitionInstances: 0,
    membershipChanges: 0,
    fullRebuilds: 0,
  };

  const setCounts = (impostorCount: number, modelCount: number): void => {
    setMeshCount(impostorMeshes, impostorCount);
    setMeshCount(modelMeshes, modelCount);
  };

  const setRenderMode = (mode: VegetationRenderMode): void => {
    if (mode === "impostors") {
      autoSlotsValid = false;
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
          impostorDetailLodBlend,
          sourceImpostorLodBlend,
          false,
        );
      } else {
        impostorMatrices.set(matrices);
        impostorOcclusion.set(activeSourceOcclusion);
        impostorColors.set(sourceColors);
      }
      setCounts(count, 0);
      updateMeshBuffers(impostorMeshes, true);
    } else if (mode === "models") {
      autoSlotsValid = false;
      modelMatrices.set(matrices);
      modelOcclusion.set(activeSourceOcclusion);
      modelColors.set(sourceColors);
      modelLodBlend.fill(1);
      setCounts(0, count);
      updateMeshBuffers(modelMeshes, true);
    } else if (lastCameraPosition) {
      updateAutoLod(lastCameraPosition, lastDistanceMeters, true);
    } else {
      impostorMatrices.set(matrices);
      impostorOcclusion.set(activeSourceOcclusion);
      impostorColors.set(sourceColors);
      setCounts(count, 0);
      updateMeshBuffers(impostorMeshes, true);
      autoSlotsValid = false;
    }
  };

  const updateAutoLod = (cameraPosition: Vector3, distanceMeters: number, forceFullUpdate = false): void => {
    const rebuildSlots = forceFullUpdate || !autoSlotsValid;
    if (rebuildSlots) lodDebugStats.fullRebuilds++;
    if (rebuildSlots) {
      modelSlotBySource.fill(-1);
      impostorSlotBySource.fill(-1);
      modelSourceBySlot.length = 0;
      impostorSourceBySlot.length = 0;
      autoModelCount = 0;
      autoImpostorCount = 0;
      autoSlotsValid = true;
    }
    const transitionWidthMeters = Math.min(LOD_TRANSITION_WIDTH_METERS, distanceMeters);
    const innerDistance = (distanceMeters - transitionWidthMeters / 2) / metersPerUnit;
    const outerDistance = (distanceMeters + transitionWidthMeters / 2) / metersPerUnit;
    const innerDistanceSquared = innerDistance * innerDistance;
    const outerDistanceSquared = outerDistance * outerDistance;
    const currentTransitionIndices = new Set<number>();
    const addBounds = (near: number, far: number): void => {
      const maximumVerticalOffset = Math.max(
        Math.abs(minimumInstanceY - cameraPosition.y),
        Math.abs(maximumInstanceY - cameraPosition.y),
      );
      const conservativeInnerRadius = Math.sqrt(Math.max(
        0,
        near * near - maximumVerticalOffset * maximumVerticalOffset,
      ));
      for (const index of spatialGrid.queryAnnulusBounds(
        cameraPosition.x,
        cameraPosition.z,
        conservativeInnerRadius,
        far,
      )) currentTransitionIndices.add(index);
    };
    addBounds(innerDistance, outerDistance);
    if (impostorLodRange && !impostorLodRange.forceLowest) {
      addBounds(impostorLodRange.nearDistance, impostorLodRange.farDistance);
    }
    const transitionIndices = forceFullUpdate
      ? new Set(allInstanceIndices)
      : new Set(currentTransitionIndices);
    if (!forceFullUpdate) {
      previousTransitionIndices.forEach((index) => transitionIndices.add(index));
    }
    let exactTransitionCount = 0;

    for (const instanceIndex of transitionIndices) {
      const matrixOffset = instanceIndex * 16;
      const dx = matrices[matrixOffset + 12] - cameraPosition.x;
      const dy = matrices[matrixOffset + 13] - cameraPosition.y;
      const dz = matrices[matrixOffset + 14] - cameraPosition.z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      const inModelTransition = distanceSquared > innerDistanceSquared &&
        distanceSquared < outerDistanceSquared;
      const inImpostorTransition = impostorLodRange !== undefined &&
        !impostorLodRange.forceLowest &&
        distanceSquared > impostorLodRange.nearDistance ** 2 &&
        distanceSquared < impostorLodRange.farDistance ** 2;
      if (inModelTransition || inImpostorTransition) exactTransitionCount++;
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
      const previousModelWeight = sourceLodBlend[instanceIndex];
      const previousImpostorWeight = sourceImpostorLodBlend[instanceIndex];
      sourceLodBlend[instanceIndex] = modelWeight;
      if (impostorLodRange && !impostorLodRange.forceLowest) {
        sourceImpostorLodBlend[instanceIndex] = smoothstepDistance(
          Math.sqrt(distanceSquared),
          impostorLodRange.nearDistance,
          impostorLodRange.farDistance,
        );
      }

      updatePackedMembership(
        instanceIndex,
        modelWeight > 0,
        true,
        rebuildSlots,
      );
      updatePackedMembership(
        instanceIndex,
        modelWeight < 1,
        false,
        rebuildSlots,
      );
      const modelSlot = modelSlotBySource[instanceIndex];
      if (modelSlot >= 0 && (rebuildSlots || modelWeight !== previousModelWeight)) {
        modelLodBlend[modelSlot] = modelWeight;
        if (!rebuildSlots) {
          partialUpdateArray(modelMeshes, "instanceLodBlend", modelLodBlend, modelSlot, 1);
        }
      }
      const impostorSlot = impostorSlotBySource[instanceIndex];
      if (impostorSlot >= 0) {
        impostorLodBlend[impostorSlot] = modelWeight;
        impostorDetailLodBlend[impostorSlot] = sourceImpostorLodBlend[instanceIndex];
        if (!rebuildSlots) {
          if (modelWeight !== previousModelWeight) {
            partialUpdateArray(
              impostorMeshes,
              "instanceLodBlend",
              impostorLodBlend,
              impostorSlot,
              1,
            );
          }
          if (sourceImpostorLodBlend[instanceIndex] !== previousImpostorWeight) {
            partialUpdateArray(
              impostorMeshes,
              "impostorDetailLodBlend",
              impostorDetailLodBlend,
              impostorSlot,
              1,
            );
          }
        }
      }
    }
    recordLodDebugUpdate(
      transitionIndices.size,
      currentTransitionIndices.size,
      exactTransitionCount,
    );
    previousTransitionIndices = currentTransitionIndices;
    setCounts(autoImpostorCount, autoModelCount);
    if (rebuildSlots) {
      updateMeshBuffers(impostorMeshes, true);
      updateMeshBuffers(modelMeshes, true);
    }
  };

  const updatePackedMembership = (
    sourceIndex: number,
    shouldBePresent: boolean,
    model: boolean,
    rebuilding: boolean,
  ): void => {
    const slotBySource = model ? modelSlotBySource : impostorSlotBySource;
    const sourceBySlot = model ? modelSourceBySlot : impostorSourceBySlot;
    const currentSlot = slotBySource[sourceIndex];
    if (shouldBePresent === (currentSlot >= 0)) return;
    lodDebugStats.membershipChanges++;

    if (shouldBePresent) {
      const slot = model ? autoModelCount++ : autoImpostorCount++;
      slotBySource[sourceIndex] = slot;
      sourceBySlot[slot] = sourceIndex;
      writePackedSlot(model, slot, sourceIndex, rebuilding);
      return;
    }

    const lastSlot = (model ? autoModelCount : autoImpostorCount) - 1;
    const movedSourceIndex = sourceBySlot[lastSlot];
    if (currentSlot !== lastSlot) {
      sourceBySlot[currentSlot] = movedSourceIndex;
      slotBySource[movedSourceIndex] = currentSlot;
      writePackedSlot(model, currentSlot, movedSourceIndex, rebuilding);
    }
    sourceBySlot.pop();
    slotBySource[sourceIndex] = -1;
    if (model) autoModelCount--;
    else autoImpostorCount--;
  };

  const writePackedSlot = (
    model: boolean,
    slot: number,
    sourceIndex: number,
    rebuilding: boolean,
  ): void => {
    const destinationMatrices = model ? modelMatrices : impostorMatrices;
    const destinationOcclusion = model ? modelOcclusion : impostorOcclusion;
    const destinationColors = model ? modelColors : impostorColors;
    const destinationLod = model ? modelLodBlend : impostorLodBlend;
    copyMatrix(destinationMatrices, slot * 16, matrices, sourceIndex * 16);
    copyColor(destinationColors, slot * 3, sourceColors, sourceIndex * 3);
    destinationOcclusion[slot] = activeSourceOcclusion[sourceIndex];
    destinationLod[slot] = sourceLodBlend[sourceIndex];
    if (!model) impostorDetailLodBlend[slot] = sourceImpostorLodBlend[sourceIndex];
    if (rebuilding) return;

    const meshes = model ? modelMeshes : impostorMeshes;
    partialUpdateArray(meshes, "matrix", destinationMatrices, slot * 16, 16);
    partialUpdateArray(meshes, "instanceOcclusion", destinationOcclusion, slot, 1);
    partialUpdateArray(meshes, "vegetationColor", destinationColors, slot * 3, 3);
    partialUpdateArray(meshes, "instanceLodBlend", destinationLod, slot, 1);
    if (!model) {
      partialUpdateArray(meshes, "impostorDetailLodBlend", impostorDetailLodBlend, slot, 1);
    }
  };

  const updateLod = (cameraPosition: Vector3, distanceMeters: number): boolean => {
    if (
      lastCameraPosition &&
      Vector3.DistanceSquared(cameraPosition, lastCameraPosition) < 1e-12 &&
      distanceMeters === lastDistanceMeters
    ) return false;
    const previousCameraPosition = lastCameraPosition;
    const distanceChanged = distanceMeters !== lastDistanceMeters;
    const transitionWidth = Math.min(LOD_TRANSITION_WIDTH_METERS, distanceMeters) / metersPerUnit;
    const impostorTransitionWidth = impostorLodRange
      ? impostorLodRange.farDistance - impostorLodRange.nearDistance
      : Number.POSITIVE_INFINITY;
    const maximumIncrementalMovement = Math.min(transitionWidth, impostorTransitionWidth);
    const forceFullUpdate = !previousCameraPosition || distanceChanged || Vector3.Distance(
      cameraPosition,
      previousCameraPosition,
    ) >= maximumIncrementalMovement;
    lastCameraPosition = cameraPosition.clone();
    lastDistanceMeters = distanceMeters;
    if (mode === "auto") {
      updateAutoLod(cameraPosition, distanceMeters, forceFullUpdate);
    } else if (mode === "impostors") {
      updateImpostorOnlyLod(cameraPosition, forceFullUpdate);
    }
    return true;
  };

  const updateImpostorOnlyLod = (cameraPosition: Vector3, forceFullUpdate: boolean): void => {
    if (!impostorLodRange || impostorLodRange.forceLowest) return;
    const maximumVerticalOffset = Math.max(
      Math.abs(minimumInstanceY - cameraPosition.y),
      Math.abs(maximumInstanceY - cameraPosition.y),
    );
    const innerRadius = Math.sqrt(Math.max(
      0,
      impostorLodRange.nearDistance ** 2 - maximumVerticalOffset ** 2,
    ));
    const currentIndices = new Set(spatialGrid.queryAnnulusBounds(
      cameraPosition.x,
      cameraPosition.z,
      innerRadius,
      impostorLodRange.farDistance,
    ));
    const updateIndices = forceFullUpdate ? new Set(allInstanceIndices) : new Set(currentIndices);
    if (!forceFullUpdate) {
      previousImpostorTransitionIndices.forEach((index) => updateIndices.add(index));
    }
    if (forceFullUpdate) lodDebugStats.fullRebuilds++;
    let exactTransitionCount = 0;

    for (const sourceIndex of updateIndices) {
      const distance = Math.sqrt(instanceDistanceSquared(matrices, sourceIndex, cameraPosition));
      if (
        distance > impostorLodRange.nearDistance &&
        distance < impostorLodRange.farDistance
      ) exactTransitionCount++;
      const blend = smoothstepDistance(
        distance,
        impostorLodRange.nearDistance,
        impostorLodRange.farDistance,
      );
      sourceImpostorLodBlend[sourceIndex] = blend;
      impostorDetailLodBlend[sourceIndex] = blend;
      if (!forceFullUpdate) {
        partialUpdateArray(
          impostorMeshes,
          "impostorDetailLodBlend",
          impostorDetailLodBlend,
          sourceIndex,
          1,
        );
      }
    }
    recordLodDebugUpdate(updateIndices.size, currentIndices.size, exactTransitionCount);
    previousImpostorTransitionIndices = currentIndices;
    if (forceFullUpdate) {
      for (const mesh of impostorMeshes) {
        mesh.thinInstanceBufferUpdated("impostorDetailLodBlend");
      }
    }
  };

  const recordLodDebugUpdate = (
    processed: number,
    currentCandidates: number,
    currentTransitions: number,
  ): void => {
    lodDebugStats.updates++;
    lodDebugStats.processedInstances += processed;
    lodDebugStats.peakProcessedInstances = Math.max(
      lodDebugStats.peakProcessedInstances,
      processed,
    );
    lodDebugStats.currentGridCandidates = currentCandidates;
    lodDebugStats.currentTransitionInstances = currentTransitions;
  };

  const consumeLodDebugStats = (): VegetationLodDebugStats => {
    const snapshot = { ...lodDebugStats };
    lodDebugStats.updates = 0;
    lodDebugStats.processedInstances = 0;
    lodDebugStats.peakProcessedInstances = 0;
    lodDebugStats.membershipChanges = 0;
    lodDebugStats.fullRebuilds = 0;
    return snapshot;
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
    consumeLodDebugStats,
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
  destinationImpostorLodBlend?: Float32Array,
  sourceImpostorLodBlend?: Float32Array,
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
    if (destinationImpostorLodBlend && sourceImpostorLodBlend) {
      destinationImpostorLodBlend[destinationIndex] = sourceImpostorLodBlend[sourceIndex];
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
  impostorDetailLodBlend?: Float32Array,
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
    if (impostorDetailLodBlend) {
      mesh.thinInstanceSetBuffer("impostorDetailLodBlend", impostorDetailLodBlend, 1, false);
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
      mesh.thinInstanceBufferUpdated("impostorDetailLodBlend");
    }
  });
}

function partialUpdateArray(
  meshes: Mesh[],
  kind: string,
  source: Float32Array,
  offset: number,
  length: number,
): void {
  const data = source.subarray(offset, offset + length);
  for (const mesh of meshes) mesh.thinInstancePartialBufferUpdate(kind, data, offset);
}

function smoothstepDistance(distance: number, nearDistance: number, farDistance: number): number {
  if (distance <= nearDistance) return 0;
  if (distance >= farDistance) return 1;
  const linear = (distance - nearDistance) / (farDistance - nearDistance);
  return linear * linear * (3 - 2 * linear);
}

function setMeshCount(meshes: Mesh[], count: number): void {
  for (const mesh of meshes) {
    mesh.thinInstanceCount = count;
    mesh.setEnabled(count > 0);
  }
}
