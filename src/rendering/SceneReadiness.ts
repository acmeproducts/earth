import { Mesh, ShaderMaterial, type Scene } from '@babylonjs/core';

/** LOD can leave an allocated instance buffer with zero active instances.
 * Compile its eventual drawing variant before the first player movement.
 * Call only while gameplay rendering is stopped behind the loading screen.
 */
export async function prepareInactiveInstanceShaders(scene: Scene): Promise<void> {
  for (const mesh of scene.meshes) {
    if (!(mesh instanceof Mesh) || !(mesh.material instanceof ShaderMaterial) ||
        mesh.hasThinInstances || !mesh.isVerticesDataPresent('world0')) continue;
    const count = mesh.forcedInstanceCount;
    try {
      mesh.forcedInstanceCount = 1;
      await mesh.material.forceCompilationAsync(mesh, { useInstances: true });
    } finally {
      mesh.forcedInstanceCount = count;
    }
  }
}

/** Finish initial shader compilation and GPU uploads behind the loading screen.
 * Scene readiness alone only guarantees that resources were submitted; the
 * first gameplay frame would otherwise inherit the queued GPU work.
 */
export async function prepareSceneForReveal(scene: Scene): Promise<void> {
  await prepareInactiveInstanceShaders(scene);
  await scene.whenReadyAsync(true);
  const engine = scene.getEngine();
  engine.beginFrame();
  try {
    scene.render();
  } finally {
    engine.endFrame();
  }
  await scene.whenReadyAsync(true);
  // A one-pixel readback fences submitted rendering on both engine backends.
  // This happens once during initialization, never in the gameplay loop.
  await engine.readPixels(0, 0, 1, 1);
}
