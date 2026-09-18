import assert from "node:assert/strict";
import test from "node:test";
import { MeshBuilder, NullEngine, Ray, Scene, TransformNode, UniversalCamera, Vector3 } from "@babylonjs/core";
import { findInteraction } from "../src/app/InteractionSystem.ts";
import { createBuildingDoor } from "../src/procedural/BuildingDoor.ts";
import { moveWalkerWithCollisions } from "../src/app/WalkerCollision.ts";

for (const scale of [1, 10]) test(`doors target, swing, collide and dispose under a moved parent at scale ${scale}`, () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  engine.getDeltaTime = () => 16;
  scene.collisionsEnabled = true;
  try {
    const root = new TransformNode("tile", scene);
    root.position.set(15, 0, 20);
    const door = createBuildingDoor(scene, {
      id: "entry", type: "door", start: { x: 0, y: 0 }, end: { x: 1.35, y: 0 },
    }, 0, 2.2, scale);
    door.parent = root;
    const origin = new Vector3(15 + 0.65 / scale, 1.8 / scale, 20 - 2 / scale);
    const ray = new Ray(origin, Vector3.Forward(), 3 / scale);
    const update = () => scene.meshes.forEach((mesh) => mesh.computeWorldMatrix(true));
    const animate = () => {
      for (let i = 0; i < 30; i++) scene.onBeforeRenderObservable.notifyObservers(scene);
      update();
    };
    update();
    const action = findInteraction(scene, ray);
    assert.equal(action?.label, "Open door");
    assert.equal(findInteraction(scene, new Ray(origin, Vector3.Forward(), 1 / scale)), undefined);
    const blocker = MeshBuilder.CreateBox("wall", { size: 0.5 / scale }, scene);
    blocker.position.copyFrom(origin.add(new Vector3(0, 0, 1 / scale)));
    update();
    assert.equal(findInteraction(scene, ray), undefined, "wall blocks targeting");
    blocker.dispose();
    root.setEnabled(false);
    assert.equal(findInteraction(scene, ray), undefined);
    root.setEnabled(true);

    const camera = new UniversalCamera("walker", origin.clone(), scene);
    camera.ellipsoid.set(0.3 / scale, 0.9 / scale, 0.3 / scale);
    camera.checkCollisions = true;
    for (let i = 0; i < 12; i++) moveWalkerWithCollisions(camera, 0, 0.2 / scale);
    assert.ok(camera.position.z < 20, "closed leaf stops the walker");
    camera.position.copyFrom(origin);
    action.activate();
    assert.equal(action.label, "Close door");
    animate();
    assert.ok(Math.abs(door.rotation.y - Math.PI / 2) < 1e-6);
    assert.equal(findInteraction(scene, ray), undefined, "open leaf clears the entrance");
    for (let i = 0; i < 12; i++) moveWalkerWithCollisions(camera, 0, 0.2 / scale);
    assert.ok(camera.position.z > 20, "walker passes through the open doorway");
    action.activate();
    assert.equal(action.label, "Close door", "closing is blocked while the player is in the swing area");
    camera.position.copyFrom(origin);
    action.activate();
    animate();
    assert.equal(findInteraction(scene, ray)?.label, "Open door");
    const observerCount = () => scene.onBeforeRenderObservable.observers.filter((observer) => !observer._willBeUnregistered).length;
    const observers = observerCount();
    action.activate();
    root.dispose(false, true);
    assert.equal(scene.meshes.length, 0);
    assert.equal(observerCount(), observers);
    assert.equal(findInteraction(scene, ray), undefined);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
