import { Engine, Scene } from "@babylonjs/core";

const UPDATE_INTERVAL_MS = 500;

export class FpsCounter {
  private readonly element: HTMLElement;
  private lastUpdate = 0;

  constructor() {
    this.element = document.createElement("output");
    this.element.id = "fpsCounter";
    this.element.setAttribute("aria-label", "Frames per second");
    this.element.textContent = "-- FPS";
    document.body.appendChild(this.element);
  }

  update(engine: Engine, scene?: Scene): void {
    const now = performance.now();
    if (now - this.lastUpdate < UPDATE_INTERVAL_MS) return;

    this.lastUpdate = now;
    const fps = `${Math.round(engine.getFps())} FPS`;
    this.element.textContent = scene
      ? `${fps}  ${formatCount(scene.getActiveIndices() / 3)} tris`
      : fps;
  }

  dispose(): void {
    this.element.remove();
  }
}

function formatCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toString();
}
