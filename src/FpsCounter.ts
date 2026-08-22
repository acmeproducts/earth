import {
  AbstractEngine,
  Engine,
  EngineInstrumentation,
  Mesh,
  Scene,
  SceneInstrumentation,
} from "@babylonjs/core";

const UPDATE_INTERVAL_MS = 500;
const FRAME_HISTORY_SIZE = 300;
const STALL_HISTORY_SIZE = 50;
const REPORT_VERSION = 1;

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
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

interface FrameHistorySample extends CpuFrameSample {
  recordedAtMilliseconds: number;
}

interface StallSample {
  startTimeMilliseconds: number;
  durationMilliseconds: number;
  blockingMilliseconds: number;
  scripts: Array<{ label: string; durationMilliseconds: number }>;
}

export interface RenderStatsContext {
  [key: string]: unknown;
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
  private readonly frameHistory: FrameHistorySample[] = [];
  private frameHistoryCursor = 0;
  private readonly stallHistory: StallSample[] = [];

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

  update(engine: AbstractEngine, scene?: Scene, cpu?: CpuFrameSample): void {
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

  dumpRenderStats(
    engine: AbstractEngine,
    scene: Scene,
    application: RenderStatsContext = {},
  ): void {
    const report = this.createRenderStatsReport(engine, scene, application);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `earth-render-stats-${timestamp}.json`;
    const json = JSON.stringify(report, null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const download = document.createElement("a");
    download.href = url;
    download.download = filename;
    download.hidden = true;
    document.body.appendChild(download);
    download.click();
    download.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    console.info(`[Render stats] Downloaded ${filename}`, report);
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
    this.instrumentation.captureCameraRenderTime = enabled;
    this.instrumentation.captureInterFrameTime = enabled;
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
    const historySample = { ...sample, recordedAtMilliseconds: performance.now() };
    if (this.frameHistory.length < FRAME_HISTORY_SIZE) {
      this.frameHistory.push(historySample);
    } else {
      this.frameHistory[this.frameHistoryCursor] = historySample;
    }
    this.frameHistoryCursor = (this.frameHistoryCursor + 1) % FRAME_HISTORY_SIZE;
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
        this.stallHistory.push({
          startTimeMilliseconds: entry.startTime,
          durationMilliseconds: entry.duration,
          blockingMilliseconds: entry.blockingDuration ?? Math.max(0, entry.duration - 50),
          scripts: (entry.scripts ?? []).map((script) => ({
            label: formatScriptLabel(script),
            durationMilliseconds: script.duration,
          })),
        });
        if (this.stallHistory.length > STALL_HISTORY_SIZE) this.stallHistory.shift();
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

  private createRenderStatsReport(
    engine: AbstractEngine,
    scene: Scene,
    application: RenderStatsContext,
  ): Record<string, unknown> {
    const activeMeshCollection = scene.getActiveMeshes();
    const activeMeshes = activeMeshCollection.data.slice(0, activeMeshCollection.length);
    const frameHistory = this.orderedFrameHistory();
    const memory = (performance as MemoryPerformance).memory;
    const camera = scene.activeCamera;
    const caps = engine.getCaps() as unknown as Record<string, unknown>;
    const meshDetails = activeMeshes.map((mesh) => {
      const sourceTriangles = mesh.getTotalIndices() / 3;
      const instances = mesh instanceof Mesh ? mesh.instances.length : 0;
      const thinInstances = mesh instanceof Mesh ? mesh.thinInstanceCount : 0;
      return {
        name: mesh.name,
        id: mesh.id,
        type: mesh.getClassName(),
        material: mesh.material
          ? { name: mesh.material.name, type: mesh.material.getClassName() }
          : null,
        vertices: mesh.getTotalVertices(),
        indices: mesh.getTotalIndices(),
        sourceTriangles,
        estimatedRenderedTriangles: sourceTriangles * Math.max(1, instances + thinInstances),
        instances,
        thinInstances,
        subMeshes: mesh.subMeshes?.length ?? 0,
        vertexBuffers: mesh instanceof Mesh ? mesh.getVerticesDataKinds() : [],
        renderingGroup: mesh.renderingGroupId,
        visibility: mesh.visibility,
        receivesShadows: mesh.receiveShadows,
      };
    }).sort((a, b) => b.estimatedRenderedTriangles - a.estimatedRenderedTriangles);

    const backendInfo = engine as AbstractEngine & {
      getInfo?: () => { vendor: string; renderer: string; version: string };
      webGLVersion?: number;
    };
    return {
      schema: "babylon-earth/render-stats",
      version: REPORT_VERSION,
      capturedAt: new Date().toISOString(),
      pageUptimeMilliseconds: performance.now(),
      application,
      browser: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGigabytes: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        devicePixelRatio: window.devicePixelRatio,
        page: `${window.location.pathname}${window.location.search}`,
      },
      engine: {
        backend: engine.isWebGPU ? "webgpu" : "webgl",
        name: engine.name,
        version: Engine.Version,
        webGLVersion: backendInfo.webGLVersion ?? null,
        gpu: backendInfo.getInfo?.() ?? null,
        hardwareScalingLevel: engine.getHardwareScalingLevel(),
        renderWidth: engine.getRenderWidth(),
        renderHeight: engine.getRenderHeight(),
        canvasClientWidth: engine.getRenderingCanvas()?.clientWidth,
        canvasClientHeight: engine.getRenderingCanvas()?.clientHeight,
        capabilities: primitiveProperties(caps),
      },
      currentFrame: {
        fps: engine.getFps(),
        engineDeltaMilliseconds: engine.getDeltaTime(),
        activeMeshes: activeMeshes.length,
        activeIndices: scene.getActiveIndices(),
        activeTriangles: scene.getActiveIndices() / 3,
        activeBones: scene.getActiveBones(),
        activeParticles: scene.getActiveParticles(),
        drawCalls: counterSnapshot(this.instrumentation.drawCallsCounter),
      },
      timings: {
        detailedInstrumentationEnabled: this.expanded,
        unit: "milliseconds",
        frame: counterSnapshot(this.instrumentation.frameTimeCounter),
        interFrame: counterSnapshot(this.instrumentation.interFrameTimeCounter),
        activeMeshEvaluation: counterSnapshot(
          this.instrumentation.activeMeshesEvaluationTimeCounter,
        ),
        renderTargets: counterSnapshot(this.instrumentation.renderTargetsRenderTimeCounter),
        cameraRender: counterSnapshot(this.instrumentation.cameraRenderTimeCounter),
        drawSubmission: counterSnapshot(this.instrumentation.renderTimeCounter),
        animations: counterSnapshot(this.instrumentation.animationsTimeCounter),
        physics: counterSnapshot(this.instrumentation.physicsTimeCounter),
        particles: counterSnapshot(this.instrumentation.particlesRenderTimeCounter),
        sprites: counterSnapshot(this.instrumentation.spritesRenderTimeCounter),
        gpuFrame: counterSnapshot(
          this.engineInstrumentation.gpuFrameTimeCounter,
          1 / 1_000_000,
        ),
        shaderCompilation: counterSnapshot(
          this.engineInstrumentation.shaderCompilationTimeCounter,
        ),
      },
      recentFrames: {
        sampleCount: frameHistory.length,
        windowMilliseconds: frameHistory.length > 1
          ? frameHistory[frameHistory.length - 1].recordedAtMilliseconds -
            frameHistory[0].recordedAtMilliseconds
          : 0,
        game: summarizeSamples(frameHistory.map((sample) => sample.gameMilliseconds)),
        vegetationLod: summarizeSamples(
          frameHistory.map((sample) => sample.vegetationMilliseconds),
        ),
        renderCall: summarizeSamples(frameHistory.map((sample) => sample.renderMilliseconds)),
        samples: frameHistory,
      },
      stalls: {
        observer: this.stallKind ?? "unavailable",
        retainedEntries: this.stallHistory.length,
        entries: this.stallHistory,
      },
      memory: memory
        ? {
          usedJSHeapBytes: memory.usedJSHeapSize,
          totalJSHeapBytes: memory.totalJSHeapSize,
          jsHeapLimitBytes: memory.jsHeapSizeLimit,
        }
        : { available: false },
      camera: camera
        ? {
          name: camera.name,
          type: camera.getClassName(),
          position: vectorSnapshot(camera.globalPosition),
          rotation: vectorSnapshot((camera as typeof camera & {
            rotation?: { x: number; y: number; z: number };
          }).rotation),
          minZ: camera.minZ,
          maxZ: camera.maxZ,
          fovRadians: camera.fov,
          mode: camera.mode,
        }
        : null,
      scene: {
        totals: {
          meshes: scene.meshes.length,
          transformNodes: scene.transformNodes.length,
          geometries: scene.geometries.length,
          materials: scene.materials.length,
          textures: scene.textures.length,
          lights: scene.lights.length,
          cameras: scene.cameras.length,
          skeletons: scene.skeletons.length,
          particleSystems: scene.particleSystems.length,
          animationGroups: scene.animationGroups.length,
          totalVertices: scene.getTotalVertices(),
        },
        flags: {
          collisionsEnabled: scene.collisionsEnabled,
          fogEnabled: scene.fogEnabled,
          fogMode: scene.fogMode,
          shadowsEnabled: scene.shadowsEnabled,
          particlesEnabled: scene.particlesEnabled,
          animationsEnabled: scene.animationsEnabled,
        },
        materials: scene.materials.map((material) => ({
          name: material.name,
          id: material.id,
          type: material.getClassName(),
          frozen: material.isFrozen,
          activeTextures: material.getActiveTextures().map((texture) => texture.name),
        })),
        textures: scene.textures.map((texture) => {
          const size = texture.getSize();
          return {
            name: texture.name,
            type: texture.getClassName(),
            width: size.width,
            height: size.height,
            ready: texture.isReady(),
            hasAlpha: texture.hasAlpha,
          };
        }),
        activeMeshes: meshDetails,
      },
    };
  }

  private orderedFrameHistory(): FrameHistorySample[] {
    if (this.frameHistory.length < FRAME_HISTORY_SIZE || this.frameHistoryCursor === 0) {
      return this.frameHistory.slice();
    }
    return [
      ...this.frameHistory.slice(this.frameHistoryCursor),
      ...this.frameHistory.slice(0, this.frameHistoryCursor),
    ];
  }
}

interface CounterLike {
  min: number;
  max: number;
  average: number;
  lastSecAverage: number;
  current: number;
  total: number;
  count: number;
}

function counterSnapshot(counter: CounterLike | null, scale = 1): Record<string, number> | null {
  if (!counter) return null;
  return {
    current: counter.current * scale,
    lastSecondAverage: counter.lastSecAverage * scale,
    lifetimeAverage: counter.average * scale,
    minimum: counter.min * scale,
    maximum: counter.max * scale,
    total: counter.total * scale,
    samples: counter.count,
  };
}

function summarizeSamples(values: number[]): Record<string, number> | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    average: total / values.length,
    minimum: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    maximum: sorted[sorted.length - 1],
  };
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function primitiveProperties(source: Record<string, unknown>): Record<string, boolean | number | string> {
  return Object.fromEntries(Object.entries(source).filter(([, value]) =>
    typeof value === "boolean" || typeof value === "number" || typeof value === "string"
  )) as Record<string, boolean | number | string>;
}

function vectorSnapshot(
  vector: { x: number; y: number; z: number } | undefined,
): Record<string, number> | null {
  return vector ? { x: vector.x, y: vector.y, z: vector.z } : null;
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
