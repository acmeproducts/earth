import { Mesh, ShaderMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { SpatialReferenceGrid } from "./SpatialReferenceGrid";

export type VegetationRenderMode = "impostors" | "auto" | "models";

/** Narrow enough to keep the movement-time transition working set small. */
const LOD_TRANSITION_WIDTH_METERS = 20;

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
  /** Dithers the whole field in or out; 0 hides it and 1 shows it fully. */
  setFade(fade: number): void;
  /** Updates packed model/impostor instances; true when the shadow map changed. */
  updateLod(cameraPosition: Vector3, distanceMeters: number): boolean;
  consumeLodDebugStats(): VegetationLodDebugStats;
}

export async function createVegetationFieldResult(
  root: TransformNode,
  impostorMeshes: Mesh[],
  modelMeshes: Mesh[],
  matrices: Float32Array,
  metersPerUnit: number,
  initialMode: VegetationRenderMode,
  instanceColors?: Float32Array,
  yieldControl?: () => Promise<void>,
): Promise<VegetationFieldResult> {
  const count = matrices.length / 16;
  if (instanceColors && instanceColors.length !== count * 3) {
    throw new Error("Instance color count must match the vegetation matrix count.");
  }
  const impostorMatrices = new Float32Array(matrices.length);
  const modelMatrices = new Float32Array(matrices.length);
  const sourceColors = instanceColors ?? new Float32Array(count * 3).fill(1);
  const impostorColors = new Float32Array(sourceColors.length);
  const modelColors = new Float32Array(sourceColors.length);
  const impostorLodBlend = new Float32Array(count);
  const modelLodBlend = new Float32Array(count);
  const sourceLodBlend = new Float32Array(count);
  impostorMatrices.set(matrices);
  await yieldControl?.();
  modelMatrices.set(matrices);
  await yieldControl?.();
  impostorColors.set(sourceColors);
  modelColors.set(sourceColors);
  modelLodBlend.fill(1);

  initializeMeshes(impostorMeshes, impostorMatrices, impostorColors, impostorLodBlend);
  await yieldControl?.();
  initializeMeshes(modelMeshes, modelMatrices, modelColors, modelLodBlend);

  let mode = initialMode;
  let lastCameraPosition: Vector3 | undefined;
  let lastDistanceMeters = 10;
  const allInstanceIndices: number[] = [];
  let minimumInstanceY = Number.POSITIVE_INFINITY;
  let maximumInstanceY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < count; index++) {
    allInstanceIndices.push(index);
    minimumInstanceY = Math.min(minimumInstanceY, matrices[index * 16 + 13]);
    maximumInstanceY = Math.max(maximumInstanceY, matrices[index * 16 + 13]);
    if ((index & 511) === 511) await yieldControl?.();
  }
  const spatialGrid = new SpatialReferenceGrid<number>(
    [],
    Math.max(1 / metersPerUnit, Math.min(LOD_TRANSITION_WIDTH_METERS / metersPerUnit, 16 / metersPerUnit)),
  );
  for (let index = 0; index < count; index++) {
    spatialGrid.add({
      x: matrices[index * 16 + 12],
      z: matrices[index * 16 + 14],
      value: index,
    });
    if ((index & 511) === 511) await yieldControl?.();
  }
  let previousTransitionIndices = new Set<number>();
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
          matrices,
          allInstanceIndices,
          lastCameraPosition,
          impostorColors,
          sourceColors,
          impostorLodBlend,
          impostorLodBlend,
          false,
        );
      } else {
        impostorMatrices.set(matrices);
        impostorColors.set(sourceColors);
      }
      setCounts(count, 0);
      updateMeshBuffers(impostorMeshes, true);
    } else if (mode === "models") {
      autoSlotsValid = false;
      modelMatrices.set(matrices);
      modelColors.set(sourceColors);
      modelLodBlend.fill(1);
      setCounts(0, count);
      updateMeshBuffers(modelMeshes, true);
    } else if (lastCameraPosition) {
      updateAutoLod(lastCameraPosition, lastDistanceMeters, true);
    } else {
      impostorMatrices.set(matrices);
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
      if (
        distanceSquared > innerDistanceSquared &&
        distanceSquared < outerDistanceSquared
      ) exactTransitionCount++;
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
      sourceLodBlend[instanceIndex] = modelWeight;

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
      if (impostorSlot >= 0 && (rebuildSlots || modelWeight !== previousModelWeight)) {
        impostorLodBlend[impostorSlot] = modelWeight;
        if (!rebuildSlots) {
          partialUpdateArray(impostorMeshes, "instanceLodBlend", impostorLodBlend, impostorSlot, 1);
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
    const destinationColors = model ? modelColors : impostorColors;
    const destinationLod = model ? modelLodBlend : impostorLodBlend;
    copyMatrix(destinationMatrices, slot * 16, matrices, sourceIndex * 16);
    copyColor(destinationColors, slot * 3, sourceColors, sourceIndex * 3);
    destinationLod[slot] = sourceLodBlend[sourceIndex];
    if (rebuilding) return;

    const meshes = model ? modelMeshes : impostorMeshes;
    partialUpdateArray(meshes, "matrix", destinationMatrices, slot * 16, 16);
    partialUpdateArray(meshes, "vegetationColor", destinationColors, slot * 3, 3);
    partialUpdateArray(meshes, "instanceLodBlend", destinationLod, slot, 1);
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
    const forceFullUpdate = !previousCameraPosition || distanceChanged || Vector3.Distance(
      cameraPosition,
      previousCameraPosition,
    ) >= transitionWidth;
    lastCameraPosition = cameraPosition.clone();
    lastDistanceMeters = distanceMeters;
    // Impostor-only and model-only modes hold a fixed instance set; the
    // material resolves impostor detail per fragment.
    if (mode !== "auto") return false;
    updateAutoLod(cameraPosition, distanceMeters, forceFullUpdate);
    return true;
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

  const setFade = (fade: number): void => {
    for (const mesh of [...impostorMeshes, ...modelMeshes]) {
      const material = mesh.material;
      if (material instanceof ShaderMaterial) material.setFloat("fieldFade", fade);
    }
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
    setFade,
    updateLod,
    consumeLodDebugStats,
  };
}

function writeFrontToBackInstances(
  destinationMatrices: Float32Array,
  sourceMatrices: Float32Array,
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
  instanceColors?: Float32Array,
  instanceLodBlend?: Float32Array,
): void {
  for (const mesh of meshes) {
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
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

function updateMeshBuffers(meshes: Mesh[], updateInstanceData = false): void {
  meshes.forEach((mesh) => {
    mesh.thinInstanceBufferUpdated("matrix");
    if (updateInstanceData) {
      mesh.thinInstanceBufferUpdated("vegetationColor");
      mesh.thinInstanceBufferUpdated("instanceLodBlend");
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

function setMeshCount(meshes: Mesh[], count: number): void {
  for (const mesh of meshes) {
    mesh.thinInstanceCount = count;
    mesh.setEnabled(count > 0);
  }
}
