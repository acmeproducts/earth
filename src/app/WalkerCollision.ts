import { UniversalCamera, Vector3 } from "@babylonjs/core";

type CollisionCamera = UniversalCamera & {
  _collideWithWorld(displacement: Vector3): void;
};

/** Applies an immediate world-space walker displacement through Babylon's collision coordinator. */
export function moveWalkerWithCollisions(
  camera: UniversalCamera,
  deltaX: number,
  deltaZ: number,
): void {
  (camera as CollisionCamera)._collideWithWorld(new Vector3(deltaX, 0, deltaZ));
}
