import {
  AbstractEngine,
  KeyboardInfo,
  KeyboardEventTypes,
  Scene,
  UniversalCamera,
} from "@babylonjs/core";
import {
  adaptiveCameraNearClipMeters,
  MIN_CAMERA_NEAR_CLIP_METERS,
} from "./CameraDepth";
import {
  advanceWalkerVerticalMotion,
  FLY_CAMERA_INERTIA,
  WALK_CAMERA_INERTIA,
} from "./WalkerMotion";
import { moveWalkerWithCollisions } from "./WalkerCollision";
import type { WalkerBody } from "./TreeTrunkCollision";
import type { PlayerPose } from "./integration/GameProtocol";

const MIN_FLY_SPEED = 0.05;
const MAX_FLY_SPEED = 10;
const FLY_SPEED_FACTOR_PER_NOTCH = 1.25;
const WHEEL_NOTCH_PIXELS = 100;
const WALK_SPEED_METERS_PER_SECOND = 10;

export const PLAYER_HEIGHT_METERS = 1.8;
export const PLAYER_RADIUS_METERS = 0.3;
export const WALK_MAX_STEP_UP_METERS = 0.35;
export const WALK_SURFACE_PROBE_DEPTH_METERS = 12;

type MovementMode = PlayerPose["movementMode"];

interface PlayerControlsOptions {
  canvas: HTMLCanvasElement;
  engine: AbstractEngine;
  scene: Scene;
  camera: UniversalCamera;
  getMetersPerUnit: () => number | undefined;
  getGroundEyeHeight: (
    x: number,
    z: number,
    referenceEyeHeight?: number,
  ) => number | undefined;
  /** Returns true only when the terrain containing a scene position is ready. */
  isScenePositionLoaded: (x: number, z: number) => boolean;
  /**
   * Pushes the walker's body out of any tree stems it overlaps. Returns
   * undefined when no stem is within reach, so the body stays where it is.
   */
  resolveTreeTrunkCollisions: (body: WalkerBody) => { x: number; z: number } | undefined;
  isMenuOpen: () => boolean;
  onPointerLockExit: () => void;
}

/** Owns local camera input, walk/fly motion, and pointer-lock lifecycle. */
export class PlayerControls {
  private readonly heldMovementKeys = new Set<string>();
  private verticalVelocityMetersPerSecond = 0;
  private walkerJumpRequested = false;
  private pointerLockWasActive = false;
  private flySpeedOutput: HTMLOutputElement;
  private currentMovementMode: MovementMode = "fly";
  private lastLoadedX?: number;
  private lastLoadedZ?: number;

  constructor(private readonly options: PlayerControlsOptions) {
    const { camera, canvas } = options;
    camera.keysUp = [87];
    camera.keysDown = [83];
    camera.keysLeft = [65];
    camera.keysRight = [68];
    camera.inertia = FLY_CAMERA_INERTIA;

    this.flySpeedOutput = document.createElement("output");
    this.flySpeedOutput.id = "flySpeed";
    document.body.appendChild(this.flySpeedOutput);
    this.updateFlySpeedOutput();

    canvas.addEventListener("wheel", this.handleFlySpeedWheel, { passive: false });
    canvas.addEventListener("click", this.handleCanvasClick);
    document.addEventListener("pointerlockchange", this.handlePointerLockChange);
    window.addEventListener("blur", this.handleWindowBlur);
    document.body.classList.add("gameplay-input");

    options.scene.onKeyboardObservable.add(this.handleKeyboard);
  }

  get movementMode(): MovementMode {
    return this.currentMovementMode;
  }

  updateMovement(): void {
    this.constrainToLoadedTile();
    this.updateWalker();
  }

  /** Keeps camera input from carrying the player across an unloaded tile. */
  constrainToLoadedTile(): void {
    const { camera } = this.options;
    if (this.options.isScenePositionLoaded(camera.position.x, camera.position.z)) {
      this.rememberLoadedPosition();
      return;
    }
    if (this.lastLoadedX !== undefined && this.lastLoadedZ !== undefined) {
      camera.position.x = this.lastLoadedX;
      camera.position.z = this.lastLoadedZ;
    }
  }

  updateDepthPrecision(): void {
    this.updateCameraDepthPrecision();
  }

  setMenuOpen(isOpen: boolean): void {
    const { camera, canvas } = this.options;
    this.heldMovementKeys.clear();
    document.body.classList.toggle("gameplay-input", !isOpen);
    if (isOpen) {
      camera.detachControl();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    } else {
      camera.attachControl(canvas, true);
      canvas.focus({ preventScroll: true });
    }
  }

  applyRestoredPose(pose: PlayerPose): void {
    const { camera } = this.options;
    const metersPerUnit = this.options.getMetersPerUnit();
    if (!metersPerUnit) return;
    camera.position.y = pose.elevationMeters / metersPerUnit;
    camera.rotation.y = pose.yaw;
    camera.rotation.x = pose.pitch;
    if (pose.movementMode !== this.currentMovementMode) this.toggleMovementMode();
    const groundEyeHeight = this.options.getGroundEyeHeight(camera.position.x, camera.position.z);
    if (groundEyeHeight !== undefined && camera.position.y < groundEyeHeight) {
      camera.position.y = groundEyeHeight;
    }
    if (this.options.isScenePositionLoaded(camera.position.x, camera.position.z)) {
      this.rememberLoadedPosition();
    }
  }

  resetForWorldChange(): void {
    const { camera } = this.options;
    camera.position.x = 0;
    camera.position.z = 0;
    camera.cameraDirection.setAll(0);
    this.heldMovementKeys.clear();
    this.verticalVelocityMetersPerSecond = 0;
    this.lastLoadedX = undefined;
    this.lastLoadedZ = undefined;
  }

  resetVerticalMotion(): void {
    this.verticalVelocityMetersPerSecond = 0;
  }

  refreshTerrainScale(): void {
    this.configureCameraCollisionBody();
    this.ensurePlayerAboveGround();
  }

  ensureAboveGround(): void {
    this.ensurePlayerAboveGround();
  }

  dispose(): void {
    const { canvas, scene } = this.options;
    canvas.removeEventListener("wheel", this.handleFlySpeedWheel);
    canvas.removeEventListener("click", this.handleCanvasClick);
    document.removeEventListener("pointerlockchange", this.handlePointerLockChange);
    window.removeEventListener("blur", this.handleWindowBlur);
    scene.onKeyboardObservable.removeCallback(this.handleKeyboard);
    document.body.classList.remove("gameplay-input");
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    this.flySpeedOutput.remove();
  }

  private readonly handleCanvasClick = (): void => {
    this.requestPointerLock();
  };

  private readonly handlePointerLockChange = (): void => {
    if (document.pointerLockElement === this.options.canvas) {
      this.pointerLockWasActive = true;
      return;
    }
    if (!this.pointerLockWasActive) return;
    this.pointerLockWasActive = false;
    this.options.onPointerLockExit();
  };

  private readonly handleFlySpeedWheel = (event: WheelEvent): void => {
    const { camera, canvas } = this.options;
    if (this.currentMovementMode !== "fly" || event.deltaY === 0) return;
    event.preventDefault();
    const pixelsPerUnit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? Math.max(canvas.clientHeight, WHEEL_NOTCH_PIXELS)
        : 1;
    const wheelNotches = Math.max(
      -4,
      Math.min(4, (event.deltaY * pixelsPerUnit) / WHEEL_NOTCH_PIXELS),
    );
    camera.speed = Math.max(
      MIN_FLY_SPEED,
      Math.min(
        MAX_FLY_SPEED,
        camera.speed * Math.pow(FLY_SPEED_FACTOR_PER_NOTCH, -wheelNotches),
      ),
    );
    this.updateFlySpeedOutput();
  };

  private readonly handleWindowBlur = (): void => {
    this.heldMovementKeys.clear();
    this.walkerJumpRequested = false;
  };

  private readonly handleKeyboard = (kbInfo: KeyboardInfo): void => {
    if (this.options.isMenuOpen()) return;
    const key = kbInfo.event.key.toLowerCase();
    if (kbInfo.type === KeyboardEventTypes.KEYDOWN) {
      if (["w", "a", "s", "d"].includes(key)) this.heldMovementKeys.add(key);
      if (key === "g" && !(kbInfo.event as KeyboardEvent).repeat) this.toggleMovementMode();
      if (this.currentMovementMode === "walk" && kbInfo.event.code === "Space"
          && !(kbInfo.event as KeyboardEvent).repeat) {
        this.walkerJumpRequested = true;
        kbInfo.event.preventDefault();
      }
      if (this.currentMovementMode !== "fly") return;
      if (key === "q") this.options.camera.position.y -= 0.2;
      if (key === "e") this.options.camera.position.y += 0.2;
    } else if (kbInfo.type === KeyboardEventTypes.KEYUP) {
      this.heldMovementKeys.delete(key);
    }
  };

  private requestPointerLock(): void {
    const { canvas } = this.options;
    if (this.options.isMenuOpen() || document.pointerLockElement === canvas) return;
    try {
      const request = canvas.requestPointerLock() as void | Promise<void>;
      if (request instanceof Promise) void request.catch(() => undefined);
    } catch {
      // Browsers reject pointer lock without a current user activation.
    }
  }

  private updateFlySpeedOutput(): void {
    if (this.currentMovementMode === "walk") {
      this.flySpeedOutput.value = `Walk · ${WALK_SPEED_METERS_PER_SECOND.toFixed(1)} m/s · G: Fly`;
      this.flySpeedOutput.setAttribute("aria-label", "Walker mode. Press G for fly mode.");
      return;
    }
    const speed = this.options.camera.speed.toFixed(2);
    this.flySpeedOutput.value = `Fly · Speed ${speed} · G: Walk`;
    this.flySpeedOutput.setAttribute("aria-label", `Fly mode. Speed ${speed}. Press G for walker mode.`);
  }

  private toggleMovementMode(): void {
    const { camera } = this.options;
    this.currentMovementMode = this.currentMovementMode === "fly" ? "walk" : "fly";
    this.verticalVelocityMetersPerSecond = 0;
    this.walkerJumpRequested = false;
    camera.cameraDirection.setAll(0);
    camera.cameraRotation.setAll(0);
    this.heldMovementKeys.clear();

    if (this.currentMovementMode === "walk") {
      camera.keysUp = [];
      camera.keysDown = [];
      camera.keysLeft = [];
      camera.keysRight = [];
      camera.inertia = WALK_CAMERA_INERTIA;
      camera.checkCollisions = true;
      this.configureCameraCollisionBody();
      this.ensurePlayerAboveGround();
    } else {
      camera.keysUp = [87];
      camera.keysDown = [83];
      camera.keysLeft = [65];
      camera.keysRight = [68];
      camera.inertia = FLY_CAMERA_INERTIA;
      camera.checkCollisions = false;
    }
    this.updateFlySpeedOutput();
  }

  private updateWalker(): void {
    const { camera, engine } = this.options;
    const metersPerUnit = this.options.getMetersPerUnit();
    if (this.currentMovementMode !== "walk" || !metersPerUnit) return;
    // A restored pose or a movement system update can leave the camera just
    // inside a tile that has since been evicted. Recover before doing any
    // further walker simulation; an unloaded tile is never a valid surface.
    if (!this.options.isScenePositionLoaded(camera.position.x, camera.position.z)) return;
    this.rememberLoadedPosition();
    const deltaSeconds = Math.min(engine.getDeltaTime() / 1000, 0.05);
    const groundEyeHeightBeforeMove = this.options.getGroundEyeHeight(
      camera.position.x,
      camera.position.z,
      camera.position.y,
    );
    const forward = Number(this.heldMovementKeys.has("w")) - Number(this.heldMovementKeys.has("s"));
    const right = Number(this.heldMovementKeys.has("d")) - Number(this.heldMovementKeys.has("a"));
    if (forward !== 0 || right !== 0) {
      const inputLength = Math.hypot(forward, right);
      const yaw = camera.rotation.y;
      const distance = WALK_SPEED_METERS_PER_SECOND * deltaSeconds / metersPerUnit;
      const deltaX =
        (Math.sin(yaw) * forward + Math.cos(yaw) * right) * distance / inputLength;
      const deltaZ =
        (Math.cos(yaw) * forward - Math.sin(yaw) * right) * distance / inputLength;
      const nextX = camera.position.x + deltaX;
      const nextZ = camera.position.z + deltaZ;
      // Streaming is asynchronous. Stop at the edge until the destination
      // tile has finished building instead of walking over an empty gap.
      if (this.options.isScenePositionLoaded(nextX, nextZ)) {
        moveWalkerWithCollisions(camera, deltaX, deltaZ);
        this.rememberLoadedPosition();
      }
    }
    // Trees are thin instances, which Babylon's mesh collider never sees, and
    // a stand can also stream in around a standing walker. Resolve every frame.
    this.pushOutOfTreeTrunks(metersPerUnit);

    const jumpRequested = this.walkerJumpRequested;
    this.walkerJumpRequested = false;
    const verticalMotion = advanceWalkerVerticalMotion({
      eyeHeight: camera.position.y,
      verticalVelocityMetersPerSecond: this.verticalVelocityMetersPerSecond,
      groundEyeHeightBeforeMove,
      groundEyeHeightAfterMove: this.options.getGroundEyeHeight(
        camera.position.x,
        camera.position.z,
        camera.position.y,
      ),
      metersPerUnit,
      deltaSeconds,
      jumpRequested,
    });
    camera.position.y = verticalMotion.eyeHeight;
    this.verticalVelocityMetersPerSecond = verticalMotion.verticalVelocityMetersPerSecond;
  }

  private pushOutOfTreeTrunks(metersPerUnit: number): void {
    const { camera } = this.options;
    const resolved = this.options.resolveTreeTrunkCollisions({
      x: camera.position.x,
      z: camera.position.z,
      footY: camera.position.y - PLAYER_HEIGHT_METERS / metersPerUnit,
      radius: PLAYER_RADIUS_METERS / metersPerUnit,
      height: PLAYER_HEIGHT_METERS / metersPerUnit,
    });
    if (!resolved) return;
    // A stem on a tile edge could push the walker onto a tile that has not
    // finished building; staying inside the trunk is the lesser problem.
    if (!this.options.isScenePositionLoaded(resolved.x, resolved.z)) return;
    camera.position.x = resolved.x;
    camera.position.z = resolved.z;
    this.rememberLoadedPosition();
  }

  private ensurePlayerAboveGround(): void {
    const { camera } = this.options;
    if (this.currentMovementMode !== "walk") return;
    const groundEyeHeight = this.options.getGroundEyeHeight(camera.position.x, camera.position.z);
    if (groundEyeHeight !== undefined && camera.position.y < groundEyeHeight) {
      camera.position.y = groundEyeHeight;
      this.verticalVelocityMetersPerSecond = 0;
    }
  }

  private rememberLoadedPosition(): void {
    const { camera } = this.options;
    this.lastLoadedX = camera.position.x;
    this.lastLoadedZ = camera.position.z;
  }

  private configureCameraCollisionBody(): void {
    const { camera } = this.options;
    const metersPerUnit = this.options.getMetersPerUnit();
    if (!metersPerUnit) return;
    camera.ellipsoid.set(
      PLAYER_RADIUS_METERS / metersPerUnit,
      PLAYER_HEIGHT_METERS / (2 * metersPerUnit),
      PLAYER_RADIUS_METERS / metersPerUnit,
    );
    camera.minZ = MIN_CAMERA_NEAR_CLIP_METERS / metersPerUnit;
    camera.ellipsoidOffset.setAll(0);
  }

  private updateCameraDepthPrecision(): void {
    const { camera } = this.options;
    const metersPerUnit = this.options.getMetersPerUnit();
    if (!metersPerUnit) return;
    const groundEyeHeight = this.options.getGroundEyeHeight(camera.position.x, camera.position.z);
    if (groundEyeHeight === undefined) return;
    const groundHeight = groundEyeHeight - PLAYER_HEIGHT_METERS / metersPerUnit;
    const clearanceMeters = Math.max(0, (camera.position.y - groundHeight) * metersPerUnit);
    camera.minZ = adaptiveCameraNearClipMeters(clearanceMeters) / metersPerUnit;
  }
}
