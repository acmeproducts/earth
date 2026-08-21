import {
  Engine,
  EngineInstrumentation,
  Scene,
  SceneInstrumentation,
} from "@babylonjs/core";

const UPDATE_INTERVAL_MS = 500;

export interface CpuFrameSample {
  gameMilliseconds: number;
  vegetationMilliseconds: number;
  renderMilliseconds: number;
  activeTileBuilds: number;
  terrainTiles: number;
  detailTiles: number;
}

interface LongFrameEntry extends PerformanceEntry {
  blockingDuration?: number;
  scripts?: Array<{
    duration: number;
    invoker?: string;
    sourceFunctionName?: string;
    sourceURL?: string;
  }>;
}

interface MemoryPerformance extends Performance {
  memory?: { usedJSHeapSize: number };
}

export class FpsCounter {
  private readonly element: HTMLElement;
  private readonly instrumentation: SceneInstrumentation;
  private readonly engineInstrumentation: EngineInstrumentation;
  private performanceObserver?: PerformanceObserver;
  private lastUpdate = 0;
  private expanded: boolean;
  private sampleCount = 0;
  private gameMilliseconds = 0;
  private gamePeakMilliseconds = 0;
  private vegetationMilliseconds = 0;
  private vegetationPeakMilliseconds = 0;
  private renderMilliseconds = 0;
  private renderPeakMilliseconds = 0;
  private latestStreaming?: Pick<
    CpuFrameSample,
    "activeTileBuilds" | "terrainTiles" | "detailTiles"
  >;
  private stallCount = 0;
  private stallMaximumMilliseconds = 0;
  private blockingMilliseconds = 0;
  private worstScript?: { label: string; milliseconds: number };
  private stallKind?: "LoAF" | "long task";

  constructor(
    scene: Scene,
    expanded = false,
    private readonly configuration?: { renderScale: number },
  ) {
    this.instrumentation = new SceneInstrumentation(scene);
    this.engineInstrumentation = new EngineInstrumentation(scene.getEngine());
    this.expanded = expanded;
    this.element = document.createElement("output");
    this.element.id = "fpsCounter";
    this.element.setAttribute("aria-label", "Frames per second");
    this.element.textContent = "-- FPS";
    document.body.appendChild(this.element);
    this.updateAppearance();
  }

  update(engine: Engine, scene?: Scene, cpu?: CpuFrameSample): void {
    if (cpu) this.recordCpuSample(cpu);
    const now = performance.now();
    if (now - this.lastUpdate < UPDATE_INTERVAL_MS) return;

    this.lastUpdate = now;
    const fps = `${Math.round(engine.getFps())} FPS`;
    if (!scene) {
      this.element.textContent = fps;
      this.resetInterval();
      return;
    }
    const triangles = `${formatCount(scene.getActiveIndices() / 3)} tris`;
    if (!this.expanded) {
      this.element.textContent = `${fps}  ${triangles}`;
      this.resetInterval();
      return;
    }
    const frameMs = this.instrumentation.frameTimeCounter.lastSecAverage;
    const drawCalls = this.instrumentation.drawCallsCounter.lastSecAverage;
    const activeMeshesMs = this.instrumentation.activeMeshesEvaluationTimeCounter.lastSecAverage;
    const renderTargetsMs = this.instrumentation.renderTargetsRenderTimeCounter.lastSecAverage;
    const drawMs = this.instrumentation.renderTimeCounter.lastSecAverage;
    const animationsMs = this.instrumentation.animationsTimeCounter.lastSecAverage;
    const physicsMs = this.instrumentation.physicsTimeCounter.lastSecAverage;
    const particlesMs = this.instrumentation.particlesRenderTimeCounter.lastSecAverage;
    const spritesMs = this.instrumentation.spritesRenderTimeCounter.lastSecAverage;
    const gpuCounter = this.engineInstrumentation.gpuFrameTimeCounter;
    const gpuMilliseconds = (gpuCounter?.lastSecAverage ?? 0) / 1_000_000;
    const shaderCompilationMs = this.engineInstrumentation
      .shaderCompilationTimeCounter.lastSecAverage;
    const gameAverage = this.sampleCount > 0 ? this.gameMilliseconds / this.sampleCount : 0;
    const renderAverage = this.sampleCount > 0 ? this.renderMilliseconds / this.sampleCount : 0;
    const vegetationAverage = this.sampleCount > 0
      ? this.vegetationMilliseconds / this.sampleCount
      : 0;
    const streaming = this.latestStreaming;
    const memory = (performance as MemoryPerformance).memory;
    const config = this.configuration
      ? `scale ${this.configuration.renderScale.toFixed(2)}`
      : "";
    this.element.textContent = [
      `${fps}  ${frameMs.toFixed(1)} ms frame`,
      `CPU game ${gameAverage.toFixed(1)} avg / ${this.gamePeakMilliseconds.toFixed(1)} peak ms`,
      `move LOD ${vegetationAverage.toFixed(1)} avg / ` +
        `${this.vegetationPeakMilliseconds.toFixed(1)} peak ms`,
      `render call ${renderAverage.toFixed(1)} avg / ${this.renderPeakMilliseconds.toFixed(1)} peak ms`,
      `render CPU: active ${activeMeshesMs.toFixed(1)}  targets ${renderTargetsMs.toFixed(1)}  ` +
        `draw ${drawMs.toFixed(1)} ms`,
      `render GPU: ${gpuMilliseconds > 0 ? `${gpuMilliseconds.toFixed(1)} ms` : "timer unavailable"}`,
      animationsMs > 0.05 || physicsMs > 0.05
        ? `scene prep: anim ${animationsMs.toFixed(1)}  physics ${physicsMs.toFixed(1)} ms`
        : "",
      particlesMs > 0.05 || spritesMs > 0.05
        ? `inside draw: particles ${particlesMs.toFixed(1)}  sprites ${spritesMs.toFixed(1)} ms`
        : "",
      shaderCompilationMs > 0.05
        ? `shader compile ${shaderCompilationMs.toFixed(1)} ms`
        : "",
      this.stallKind
        ? `${this.stallKind} ${this.stallCount}  max ${this.stallMaximumMilliseconds.toFixed(0)} ms  ` +
          `blocked ${this.blockingMilliseconds.toFixed(0)} ms`
        : "CPU stalls unavailable",
      this.worstScript
        ? `hot ${this.worstScript.label}  ${this.worstScript.milliseconds.toFixed(0)} ms`
        : "",
      `${triangles}  ${formatCount(scene.getActiveMeshes().length)} meshes  ` +
        `${Math.round(drawCalls)} draws`,
      streaming
        ? `stream ${streaming.activeTileBuilds} build  ${streaming.terrainTiles} terrain  ` +
          `${streaming.detailTiles} detail`
        : "",
      [memory ? `${formatBytes(memory.usedJSHeapSize)} heap` : "", config]
        .filter(Boolean)
        .join("  "),
    ].filter(Boolean).join("\n");
    this.resetInterval();
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.lastUpdate = 0;
    this.updateAppearance();
  }

  dispose(): void {
    this.performanceObserver?.disconnect();
    this.engineInstrumentation.dispose();
    this.instrumentation.dispose();
    this.element.remove();
  }

  private updateAppearance(): void {
    this.element.classList.toggle("expanded", this.expanded);
    this.element.setAttribute("aria-label", this.expanded
      ? "Expanded rendering performance statistics"
      : "Frames per second and active triangles");
    if (this.expanded) {
      this.setDetailedInstrumentation(true);
      this.startPerformanceObserver();
    } else {
      this.setDetailedInstrumentation(false);
      this.performanceObserver?.disconnect();
      this.performanceObserver = undefined;
      this.stallKind = undefined;
      this.resetInterval();
    }
  }

  private setDetailedInstrumentation(enabled: boolean): void {
    this.instrumentation.captureFrameTime = enabled;
    this.instrumentation.captureActiveMeshesEvaluationTime = enabled;
    this.instrumentation.captureRenderTargetsRenderTime = enabled;
    this.instrumentation.captureRenderTime = enabled;
    this.instrumentation.captureAnimationsTime = enabled;
    this.instrumentation.capturePhysicsTime = enabled;
    this.instrumentation.captureParticlesRenderTime = enabled;
    this.instrumentation.captureSpritesRenderTime = enabled;
    this.engineInstrumentation.captureGPUFrameTime = enabled;
    this.engineInstrumentation.captureShaderCompilationTime = enabled;
  }

  private recordCpuSample(sample: CpuFrameSample): void {
    this.sampleCount++;
    this.gameMilliseconds += sample.gameMilliseconds;
    this.gamePeakMilliseconds = Math.max(this.gamePeakMilliseconds, sample.gameMilliseconds);
    this.vegetationMilliseconds += sample.vegetationMilliseconds;
    this.vegetationPeakMilliseconds = Math.max(
      this.vegetationPeakMilliseconds,
      sample.vegetationMilliseconds,
    );
    this.renderMilliseconds += sample.renderMilliseconds;
    this.renderPeakMilliseconds = Math.max(this.renderPeakMilliseconds, sample.renderMilliseconds);
    this.latestStreaming = sample;
  }

  private startPerformanceObserver(): void {
    if (this.performanceObserver || typeof PerformanceObserver === "undefined") return;
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    const entryType = supported.includes("long-animation-frame")
      ? "long-animation-frame"
      : supported.includes("longtask")
        ? "longtask"
        : undefined;
    if (!entryType) return;
    this.stallKind = entryType === "long-animation-frame" ? "LoAF" : "long task";
    this.performanceObserver = new PerformanceObserver((list) => {
      for (const rawEntry of list.getEntries()) {
        const entry = rawEntry as LongFrameEntry;
        this.stallCount++;
        this.stallMaximumMilliseconds = Math.max(this.stallMaximumMilliseconds, entry.duration);
        this.blockingMilliseconds += entry.blockingDuration ?? Math.max(0, entry.duration - 50);
        for (const script of entry.scripts ?? []) {
          if (script.duration <= (this.worstScript?.milliseconds ?? 0)) continue;
          this.worstScript = {
            label: formatScriptLabel(script),
            milliseconds: script.duration,
          };
        }
      }
    });
    this.performanceObserver.observe({ type: entryType, buffered: true });
  }

  private resetInterval(): void {
    this.sampleCount = 0;
    this.gameMilliseconds = 0;
    this.gamePeakMilliseconds = 0;
    this.vegetationMilliseconds = 0;
    this.vegetationPeakMilliseconds = 0;
    this.renderMilliseconds = 0;
    this.renderPeakMilliseconds = 0;
    this.stallCount = 0;
    this.stallMaximumMilliseconds = 0;
    this.blockingMilliseconds = 0;
    this.worstScript = undefined;
  }
}

function formatScriptLabel(script: NonNullable<LongFrameEntry["scripts"]>[number]): string {
  const source = script.sourceURL?.split("/").pop()?.split("?")[0];
  return script.sourceFunctionName || script.invoker || source || "script";
}

function formatBytes(value: number): string {
  return `${(value / (1024 * 1024)).toFixed(0)} MB`;
}

function formatCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toString();
}
