import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { FreeCameraMouseInput, Vector2, Vector3 } from "@babylonjs/core";

const source = readFileSync(new URL("../src/app/PlayerControls.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("PlayerControls.ts", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(node => ts.isClassDeclaration(node));
const { outputText } = ts.transpileModule(declaration.getText(parsed).replace("export ", ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});

function fixture() {
  const listeners = new Map();
  const element = () => ({
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, setAttribute() {}, remove() {}, focus() {},
    addEventListener(type, callback, capture) { listeners.set(type, { callback, capture }); },
    removeEventListener(type) { listeners.delete(type); },
  });
  const canvas = element();
  const document = { ...element(), body: element(), createElement: element, pointerLockElement: canvas };
  const window = element();
  const engine = { isPointerLock: true, getInputElement: () => canvas };
  const scene = {
    onKeyboardObservable: { add() {}, removeCallback() {} },
    _inputManager: { _addCameraPointerObserver: () => ({}), _removeCameraPointerObserver() {} },
  };
  const mouse = new FreeCameraMouseInput();
  const camera = {
    speed: 1, rotation: new Vector3(0.3, 1.2, 0),
    cameraDirection: Vector3.Zero(), cameraRotation: Vector2.Zero(),
    getEngine: () => engine, getScene: () => scene,
    _calculateHandednessMultiplier: () => 1,
    attachControl: () => mouse.attachControl(true),
    detachControl: () => mouse.detachControl(),
  };
  mouse.camera = camera;
  camera.attachControl();
  const PlayerControls = new Function("document", "window", "isPhone", "FLY_CAMERA_INERTIA",
    `${outputText}; return PlayerControls;`)(document, window, () => false, 0.9);
  let menuOpen = false;
  let exits = 0;
  const controls = new PlayerControls({
    canvas, camera, engine, scene, isMenuOpen: () => menuOpen,
    onPointerLockExit() { exits++; menuOpen = true; controls.setMenuOpen(true); },
  });
  listeners.get("pointerlockchange").callback();
  function move(x, y) {
    assert.equal(listeners.get("pointermove").capture, true);
    listeners.get("pointermove").callback();
    mouse._onMouseMove?.({ movementX: x, movementY: y });
    camera.rotation.x += camera.cameraRotation.x;
    camera.rotation.y += camera.cameraRotation.y;
    camera.cameraRotation.setAll(0);
  }
  return { canvas, document, engine, camera, controls, listeners, move,
    get exits() { return exits; } };
}

test("cursor restoration before pointerlockchange cannot turn the camera", () => {
  const f = fixture();
  f.move(20, -10);
  assert.equal(f.camera.rotation.y, 1.21);
  const before = f.camera.rotation.clone();
  f.camera.cameraRotation.set(0.1, 0.2);
  f.document.pointerLockElement = null;
  // Babylon still thinks it is locked when the cursor jumps back onscreen.
  assert.equal(f.engine.isPointerLock, true);
  f.move(900, -600);
  assert.deepEqual(f.camera.rotation, before);
  assert.equal(f.exits, 1);
  f.listeners.get("pointerlockchange").callback();
  assert.equal(f.exits, 1);
  f.controls.dispose();
  assert.equal(f.listeners.has("pointermove"), false);
});

test("normal unlock and subsequent pointer lock preserve working mouse look", () => {
  const f = fixture();
  f.document.pointerLockElement = null;
  f.listeners.get("pointerlockchange").callback();
  const before = f.camera.rotation.clone();
  f.move(900, -600);
  assert.deepEqual(f.camera.rotation, before);
  f.controls.setMenuOpen(false);
  f.document.pointerLockElement = f.canvas;
  f.listeners.get("pointerlockchange").callback();
  f.move(20, -10);
  assert.equal(f.camera.rotation.y, before.y + 0.01);
  assert.equal(f.camera.rotation.x, before.x - 0.005);
});
