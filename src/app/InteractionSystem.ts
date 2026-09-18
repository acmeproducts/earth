import { AbstractMesh, Ray, Scene } from "@babylonjs/core";

export interface Interaction {
  readonly label: string;
  activate(): void;
}

const interactions = new WeakMap<AbstractMesh, Interaction>();

/** Mesh ownership keeps streamed objects from leaving stale interaction targets. */
export function registerInteraction(mesh: AbstractMesh, interaction: Interaction): void {
  interactions.set(mesh, interaction);
  mesh.onDisposeObservable.addOnce(() => interactions.delete(mesh));
}

export function findInteraction(scene: Scene, ray: Ray): Interaction | undefined {
  const hit = scene.pickWithRay(ray, (mesh) => mesh.isEnabled() && mesh.isVisible &&
    (interactions.has(mesh) || mesh.checkCollisions || mesh.isPickable));
  return hit?.hit && hit.pickedMesh ? interactions.get(hit.pickedMesh) : undefined;
}
