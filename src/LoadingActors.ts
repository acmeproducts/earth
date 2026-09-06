import {
  ArcRotateCamera, Color3, Color4, DirectionalLight, Engine,
  HemisphericLight, Mesh, Scene, Vector3,
} from '@babylonjs/core';
import { createFernModel } from './FernImpostor';
import { measureFoliageTextures, TREE_SPECIES } from './procedural/ProceduralTree';

/** A small, disposable scene using the same actor generators as the world. */
export class LoadingActors {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly observer: ResizeObserver;
  private meshes: Mesh[] = [];
  private readonly actors = new Map<number, Mesh[]>();
  private disposed = false;
  private actor = 0;
  private elapsed = 0;
  private previousFrame = 0;

  constructor(canvas: HTMLCanvasElement, private readonly caption: HTMLElement) {
    this.engine = new Engine(canvas, true, { alpha: true, stencil: false }, false);
    this.engine.setHardwareScalingLevel(Math.max(1, window.devicePixelRatio / 1.5));
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    this.camera = new ArcRotateCamera('loadingCamera', -Math.PI / 2.8, Math.PI / 2.5, 6, Vector3.Zero(), this.scene);
    this.camera.minZ = 0.01;
    const fill = new HemisphericLight('skyAmbientLight', Vector3.Up(), this.scene);
    fill.intensity = 0.8;
    fill.groundColor = new Color3(0.25, 0.3, 0.22);
    const sun = new DirectionalLight('sunLight', new Vector3(-1, -2, 1), this.scene);
    sun.intensity = 1.2;
    this.observer = new ResizeObserver(() => this.engine.resize());
    this.observer.observe(canvas);
    // Texture measurement must not hold up world initialization.
    void measureFoliageTextures().then(() => {
      if (this.disposed) return;
      try {
        this.showActor();
        this.engine.runRenderLoop(this.render);
      } catch (error) {
        this.fail(error);
      }
    }).catch((error: unknown) => this.fail(error));
  }

  private showActor(): void {
    for (const mesh of this.meshes) mesh.setEnabled(false);
    const cached = this.actors.get(this.actor);
    if (cached) {
      this.meshes = cached;
    } else if (this.actor === 1) {
      this.meshes = [createFernModel(this.scene, 2, 731)];
    } else {
      const species = this.actor === 0 ? 'birch' : 'pine';
      const parts = TREE_SPECIES[species].create(this.scene, { seed: 731, liveLighting: true });
      this.meshes = [parts.log, parts.branches];
    }
    this.actors.set(this.actor, this.meshes);
    this.caption.textContent = ['Silver birch', 'Fern', 'Pine'][this.actor];
    for (const mesh of this.meshes) mesh.setEnabled(true);
    let minimum = new Vector3(Infinity, Infinity, Infinity);
    let maximum = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const mesh of this.meshes) {
      mesh.computeWorldMatrix(true);
      const bounds = mesh.getBoundingInfo().boundingBox;
      minimum = Vector3.Minimize(minimum, bounds.minimumWorld);
      maximum = Vector3.Maximize(maximum, bounds.maximumWorld);
    }
    this.camera.setTarget(minimum.add(maximum).scale(0.5));
    // A bounding sphere fits every angle of the rotating preview.
    this.camera.radius = maximum.subtract(minimum).length() * 0.5 / Math.sin(this.camera.fov / 2) * 1.15;
    this.camera.alpha = -Math.PI / 2.8;
  }

  private readonly render = (): void => {
    const now = performance.now();
    if (document.hidden || now - this.previousFrame < 1000 / 30) return;
    const delta = Math.min((now - this.previousFrame) / 1000, 0.1);
    this.previousFrame = now;
    try {
      if (!this.motion.matches) {
        this.camera.alpha += delta * 0.22;
        this.elapsed += delta;
        if (this.elapsed >= 7) {
          this.elapsed = 0;
          this.actor = (this.actor + 1) % 3;
          this.showActor();
        }
      }
      this.scene.render();
    } catch (error) {
      this.fail(error);
    }
  };

  private fail(error: unknown): void {
    console.warn('Loading actor preview unavailable:', error);
    this.caption.textContent = '';
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    this.engine.stopRenderLoop(this.render);
    this.scene.dispose();
    this.engine.dispose();
  }
}
