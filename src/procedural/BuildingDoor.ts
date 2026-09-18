import { Color3, Matrix, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { registerInteraction } from "../app/InteractionSystem";
import type { Opening2D } from "../buildings/FloorPlan";

/** Coordinates and dimensions are in meters, like the floor planner. */
export function createBuildingDoor(
  scene: Scene, opening: Opening2D, bottom: number, height: number, metersPerUnit: number,
): Mesh {
  const width = Math.hypot(opening.end.x - opening.start.x, opening.end.y - opening.start.y);
  const door = MeshBuilder.CreateBox("buildingDoor", {
    width: Math.max(0.05, width - 0.04) / metersPerUnit,
    height: (height - 0.03) / metersPerUnit,
    depth: 0.055 / metersPerUnit,
  }, scene);
  // Bake the offset so the mesh origin is the hinge, not the leaf center.
  door.bakeTransformIntoVertices(
    // Translation also puts the bottom just above the finished floor.
    Matrix.Translation(width / (2 * metersPerUnit), height / (2 * metersPerUnit), 0),
  );
  door.position.set(opening.start.x / metersPerUnit, bottom / metersPerUnit, opening.start.y / metersPerUnit);
  const closedAngle = -Math.atan2(opening.end.y - opening.start.y, opening.end.x - opening.start.x);
  door.rotation.y = closedAngle;
  const material = new StandardMaterial("buildingDoorMaterial", scene);
  material.diffuseColor = new Color3(0.28, 0.35, 0.32);
  material.specularColor = new Color3(0.16, 0.16, 0.16);
  door.material = material;
  door.checkCollisions = true;
  door.receiveShadows = true;
  door.metadata = { buildingDoor: true, openingId: opening.id, open: false };

  const handle = MeshBuilder.CreateBox("doorHandle", {
    width: 0.13 / metersPerUnit, height: 0.035 / metersPerUnit, depth: 0.12 / metersPerUnit,
  }, scene);
  handle.parent = door;
  handle.position.set((width - 0.16) / metersPerUnit, Math.min(1, height * 0.5) / metersPerUnit, 0);
  const metal = new StandardMaterial("doorHandleMaterial", scene);
  metal.diffuseColor = new Color3(0.68, 0.7, 0.72);
  handle.material = metal;
  handle.checkCollisions = true;
  let targetAngle = closedAngle;
  let animation: ReturnType<typeof scene.onBeforeRenderObservable.add> | undefined;
  const interaction = {
    get label(): string { return door.metadata.open ? "Close door" : "Open door"; },
    activate(): void {
      if (door.isDisposed() || !door.isEnabled()) return;
      const camera = scene.activeCamera;
      if (door.metadata.open && camera) {
        camera.getViewMatrix(true);
        const local = Vector3.TransformCoordinates(camera.globalPosition,
          door.parent ? door.parent.computeWorldMatrix(true).clone().invert() : Matrix.Identity());
        const dx = local.x - door.position.x, dz = local.z - door.position.z;
        // Do not swing a closing leaf through the player standing in its arc.
        if (Math.hypot(dx, dz) * metersPerUnit < width + 0.35 &&
            local.y >= door.position.y && local.y < door.position.y + (height + 1.8) / metersPerUnit) return;
      }
      door.metadata.open = !door.metadata.open;
      targetAngle = closedAngle + (door.metadata.open ? Math.PI / 2 : 0);
      if (animation) return;
      animation = scene.onBeforeRenderObservable.add(() => {
        const step = Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05) * Math.PI * 2;
        const remaining = targetAngle - door.rotation.y;
        door.rotation.y += Math.sign(remaining) * Math.min(Math.abs(remaining), step);
        door.computeWorldMatrix(true);
        if (Math.abs(remaining) <= step) {
          scene.onBeforeRenderObservable.remove(animation!);
          animation = undefined;
        }
      });
    },
  };
  registerInteraction(door, interaction);
  registerInteraction(handle, interaction);
  door.onDisposeObservable.addOnce(() => {
    if (animation) scene.onBeforeRenderObservable.remove(animation);
    material.dispose();
    metal.dispose();
  });
  return door;
}
