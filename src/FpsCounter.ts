import { Engine, Scene, SceneInstrumentation } from "@babylonjs/core";

const UPDATE_INTERVAL_MS = 500;

export class FpsCounter {
  private readonly element: HTMLElement;
  private readonly instrumentation: SceneInstrumentation;
  private lastUpdate = 0;
  private expanded: boolean;

  constructor(
    scene: Scene,
    expanded = false,
    private readonly configuration?: { renderScale: number },
  ) {
    this.instrumentation = new SceneInstrumentation(scene);
    this.instrumentation.captureFrameTime = true;
    this.instrumentation.captureRenderTime = true;
    this.expanded = expanded;
    this.element = document.createElement("output");
    this.element.id = "fpsCounter";
    this.element.setAttribute("aria-label", "Frames per second");
    this.element.textContent = "-- FPS";
    document.body.appendChild(this.element);
    this.updateAppearance();
  }

  update(engine: Engine, scene?: Scene): void {
    const now = performance.now();
    if (now - this.lastUpdate < UPDATE_INTERVAL_MS) return;

    this.lastUpdate = now;
    const fps = `${Math.round(engine.getFps())} FPS`;
    if (!scene) {
      this.element.textContent = fps;
      return;
    }
    const triangles = `${formatCount(scene.getActiveIndices() / 3)} tris`;
    if (!this.expanded) {
      this.element.textContent = `${fps}  ${triangles}`;
      return;
    }
    const frameMs = this.instrumentation.frameTimeCounter.lastSecAverage;
    const renderMs = this.instrumentation.renderTimeCounter.lastSecAverage;
    const drawCalls = this.instrumentation.drawCallsCounter.lastSecAverage;
    const config = this.configuration
      ? `scale ${this.configuration.renderScale.toFixed(2)}`
      : "";
    this.element.textContent = [
      `${fps}  ${frameMs.toFixed(1)} ms frame`,
      `${renderMs.toFixed(1)} ms render  ${Math.round(drawCalls)} draws`,
      `${triangles}  ${formatCount(scene.getActiveMeshes().length)} meshes`,
      config,
    ].filter(Boolean).join("\n");
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.lastUpdate = 0;
    this.updateAppearance();
  }

  dispose(): void {
    this.instrumentation.dispose();
    this.element.remove();
  }

  private updateAppearance(): void {
    this.element.classList.toggle("expanded", this.expanded);
    this.element.setAttribute("aria-label", this.expanded
      ? "Expanded rendering performance statistics"
      : "Frames per second and active triangles");
  }
}

function formatCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toString();
}
