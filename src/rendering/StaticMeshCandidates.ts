import type { AbstractMesh, Scene } from "@babylonjs/core";

interface Registration {
  meshes: WeakSet<AbstractMesh>;
  results: WeakMap<AbstractMesh, { revision: number; world: number; inside: boolean }>;
}
const registrations = new WeakMap<Scene, Registration>();

/** Static scenery can be culled before Babylon's readiness, LOD and transform work. */
export function registerStaticMeshCandidates(scene: Scene, meshes: readonly AbstractMesh[]): void {
  let registered = registrations.get(scene);
  if (!registered) {
    registered = { meshes: new WeakSet(), results: new WeakMap() };
    registrations.set(scene, registered);
    const { meshes: staticMeshes, results } = registered;
    const previousTransform = new Float32Array(16).fill(NaN);
    let revision = 0;
    const original = scene.getActiveMeshCandidates;
    const candidates: { data: AbstractMesh[]; length: number } = { data: [], length: 0 };
    scene.getActiveMeshCandidates = () => {
      const source = original.call(scene);
      if (scene.skipFrustumClipping || !scene.activeCamera) return source;
      const planes = scene.frustumPlanes;
      const transform = scene.getTransformMatrix().m;
      if (transform.some((value, index) => value !== previousTransform[index])) {
        previousTransform.set(transform);
        revision++;
      }
      let count = 0;
      for (let index = 0; index < source.length; index++) {
        const mesh = source.data[index];
        if (staticMeshes.has(mesh)) {
          if (!mesh.isVisible) continue;
          if (!mesh.alwaysSelectAsActiveMesh) {
            const world = mesh.getWorldMatrix().updateFlag;
            let result = results.get(mesh);
            if (!result || result.revision !== revision || result.world !== world) {
              result = { revision, world, inside: mesh.isInFrustum(planes) };
              results.set(mesh, result);
            }
            if (!result.inside) continue;
          }
        }
        candidates.data[count++] = mesh;
      }
      candidates.data.length = candidates.length = count;
      return candidates;
    };
  }
  for (const mesh of meshes) {
    mesh.freezeWorldMatrix();
    registered.meshes.add(mesh);
    registered.results.delete(mesh);
  }
}
