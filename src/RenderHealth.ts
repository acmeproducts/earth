import type { BaseTexture, Scene } from "@babylonjs/core";

/** Reports resource failures at their source without retaining scene snapshots. */
export function monitorRenderHealth(
  scene: Scene,
  report: (message: string, detail?: unknown) => void = console.error,
): void {
  const watched = new WeakSet<BaseTexture>();
  const watch = (texture: BaseTexture): void => {
    if (watched.has(texture)) return;
    watched.add(texture);
    texture.onDisposeObservable.addOnce(() => {
      if (scene.isDisposed) return;
      const disposal = new Error(`Texture disposed: ${texture.name}`);
      // Normal recursive cleanup may dispose textures before their meshes.
      // Inspect after that cleanup finishes to avoid reporting retiring owners.
      queueMicrotask(() => {
        if (scene.isDisposed) return;
        const users = scene.meshes.filter((mesh) => !mesh.isDisposed() &&
          mesh.isEnabled() && mesh.material?.hasTexture(texture));
        if (users.length === 0) return;
        report(`[Render health] Disposed texture "${texture.name}" still used by ` +
          `${users.length} enabled meshes: ${users.slice(0, 8).map((mesh) => mesh.name).join(", ")}`, disposal);
      });
    });
  };
  scene.textures.forEach(watch);
  const added = scene.onNewTextureAddedObservable.add(watch);
  const engine = scene.getEngine();
  const lost = engine.onContextLostObservable.add(() => {
    report("[Render health] GPU context lost", {
      frame: scene.getFrameId(), meshes: scene.meshes.length,
      materials: scene.materials.length, textures: scene.textures.length,
    });
  });
  const restored = engine.onContextRestoredObservable.add(() => {
    report("[Render health] GPU context restored");
  });
  scene.onDisposeObservable.addOnce(() => {
    scene.onNewTextureAddedObservable.remove(added);
    engine.onContextLostObservable.remove(lost);
    engine.onContextRestoredObservable.remove(restored);
  });
}
