import { Mesh, TransformNode, Vector3 } from "@babylonjs/core";

export type VegetationRenderMode = "impostors" | "auto" | "models";

export interface VegetationFieldResult {
  root: TransformNode;
  meshes: Mesh[];
  impostorMeshes: Mesh[];
  modelMeshes: Mesh[];
  count: number;
  setRenderMode(mode: VegetationRenderMode): void;
  updateLod(cameraPosition: Vector3, distanceMeters: number): void;
}

export function createVegetationFieldResult(
  root: TransformNode,
  impostorMeshes: Mesh[],
  modelMeshes: Mesh[],
  matrices: Float32Array,
  metersPerUnit: number,
  initialMode: VegetationRenderMode,
): VegetationFieldResult {
  const count = matrices.length / 16;
  const impostorMatrices = new Float32Array(matrices.length);
  const modelMatrices = new Float32Array(matrices.length);
  impostorMatrices.set(matrices);
  modelMatrices.set(matrices);

  initializeMeshes(impostorMeshes, impostorMatrices);
  initializeMeshes(modelMeshes, modelMatrices);

  let mode = initialMode;
  let lastCameraPosition: Vector3 | undefined;
  let lastDistanceMeters = 10;

  const setCounts = (impostorCount: number, modelCount: number): void => {
    setMeshCount(impostorMeshes, impostorCount);
    setMeshCount(modelMeshes, modelCount);
  };

  const setRenderMode = (mode: VegetationRenderMode): void => {
    if (mode === "impostors") {
      impostorMatrices.set(matrices);
      setCounts(count, 0);
      updateMeshBuffers(impostorMeshes);
    } else if (mode === "models") {
      modelMatrices.set(matrices);
      setCounts(0, count);
      updateMeshBuffers(modelMeshes);
    } else if (lastCameraPosition) {
      updateAutoLod(lastCameraPosition, lastDistanceMeters);
    } else {
      setCounts(count, 0);
    }
  };

  const updateAutoLod = (cameraPosition: Vector3, distanceMeters: number): void => {
    const maximumDistance = distanceMeters / metersPerUnit;
    const maximumDistanceSquared = maximumDistance * maximumDistance;
    let impostorCount = 0;
    let modelCount = 0;

    for (let matrixOffset = 0; matrixOffset < matrices.length; matrixOffset += 16) {
      const dx = matrices[matrixOffset + 12] - cameraPosition.x;
      const dy = matrices[matrixOffset + 13] - cameraPosition.y;
      const dz = matrices[matrixOffset + 14] - cameraPosition.z;
      const useModel = dx * dx + dy * dy + dz * dz <= maximumDistanceSquared;
      const destination = useModel ? modelMatrices : impostorMatrices;
      const instanceIndex = useModel ? modelCount++ : impostorCount++;
      const destinationOffset = instanceIndex * 16;
      for (let element = 0; element < 16; element++) {
        destination[destinationOffset + element] = matrices[matrixOffset + element];
      }
    }

    setCounts(impostorCount, modelCount);
    updateMeshBuffers(impostorMeshes);
    updateMeshBuffers(modelMeshes);
  };

  const updateLod = (cameraPosition: Vector3, distanceMeters: number): void => {
    lastCameraPosition = cameraPosition.clone();
    lastDistanceMeters = distanceMeters;
    if (mode === "auto") updateAutoLod(cameraPosition, distanceMeters);
  };

  const applyRenderMode = (nextMode: VegetationRenderMode): void => {
    mode = nextMode;
    setRenderMode(nextMode);
  };

  applyRenderMode(initialMode);
  return {
    root,
    meshes: [...impostorMeshes, ...modelMeshes],
    impostorMeshes,
    modelMeshes,
    count,
    setRenderMode: applyRenderMode,
    updateLod,
  };
}

function initializeMeshes(meshes: Mesh[], matrices: Float32Array): void {
  for (const mesh of meshes) {
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
    mesh.thinInstanceRefreshBoundingInfo(true);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.freezeWorldMatrix();
  }
}

function updateMeshBuffers(meshes: Mesh[]): void {
  meshes.forEach((mesh) => mesh.thinInstanceBufferUpdated("matrix"));
}

function setMeshCount(meshes: Mesh[], count: number): void {
  for (const mesh of meshes) {
    mesh.thinInstanceCount = count;
    mesh.setEnabled(count > 0);
  }
}
