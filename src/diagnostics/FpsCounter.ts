import {
  AbstractEngine,
  Engine,
  EngineInstrumentation,
  Mesh,
  RenderTargetTexture,
  Scene,
  SceneInstrumentation,
} from "@babylonjs/core";
import { streamingDiagnosticsSnapshot } from "./StreamingDiagnostics";
import { creationStats, SLOW_OPERATION_THRESHOLD_MS } from "./CreationStats";

const UPDATE_INTERVAL_MS = 500;
const FRAME_HISTORY_SIZE = 300;
const STALL_HISTORY_SIZE = 50;
const REPORT_VERSION = 8;
const MAX_CADENCE_SAMPLE_MILLISECONDS = 100;
const BENCHMARK_WARMUP_FRAMES = 60;
const BENCHMARK_SAMPLE_FRAMES = 120;
const BENCHMARK_WARMUP_MS = 1500;
const BENCHMARK_SAMPLE_MS = 3000;

export interface CpuFrameSample {
  gameMilliseconds: number;
  vegetationMilliseconds: number;
  renderMilliseconds: number;
  activeTileBuilds: number;
  terrainTiles: number;
  detailTiles: number;
  activeLayerFades?: number;
}

export interface RenderBenchmarkPhase {
  name: string;
  apply: () => void;
  captureContext?: () => RenderStatsContext;
}

interface RenderBenchmarkSample {
  frameIntervalMilliseconds: number;
  gameMilliseconds: number;
  renderMilliseconds: number;
  gpuFrameMilliseconds: number;
  drawCalls: number;
  activeTriangles: number;
}

interface RenderBenchmarkResult {
  name: string;
  samples: number;
  gpuSamples: number;
  context?: RenderStatsContext;
  baselinePhaseIndex?: number;
  frameInterval: Record<string, number> | null;
  fps: Record<string, number> | null;
  gpuFrame: Record<string, number> | null;
  game: Record<string, number> | null;
  renderCall: Record<string, number> | null;
  drawCalls: Record<string, number> | null;
  activeTriangles: Record<string, number> | null;
  relativeToBaseline?: {
    averageFpsPercent: number;
    averageFrameTimePercent: number;
    averageGpuTimePercent: number | null;
  };
}

interface ActiveRenderBenchmark {
  phases: readonly RenderBenchmarkPhase[];
  phaseIndex: number;
  warmupFrames: number;
  warmupMilliseconds: number;
  lastGpuSampleCount: number;
  samples: RenderBenchmarkSample[];
  results: RenderBenchmarkResult[];
  onComplete: () => void;
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
  frameIntervalMilliseconds: number;
  callbackMilliseconds: number;
  unattributedMilliseconds: number;
  frameBudgetMilliseconds: number;
  stutter: boolean;
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
  private readonly configuration?: { renderScale: number };
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
  private frameIntervalMilliseconds = 0;
  private frameIntervalPeakMilliseconds = 0;
  private unattributedPeakMilliseconds = 0;
  private stutterCount = 0;
  private lastFrameRecordedAt?: number;
  private cadenceMilliseconds?: number;
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
  private benchmark?: ActiveRenderBenchmark;
  private benchmarkResults?: RenderBenchmarkResult[];

  constructor(
    scene: Scene,
    expanded = false,
    configuration?: { renderScale: number },
  ) {
    this.configuration = configuration;
    this.instrumentation = new SceneInstrumentation(scene);
    this.engineInstrumentation = new EngineInstrumentation(scene.getEngine());
    this.expanded = expanded;
    this.element = document.createElement("output");
    this.element.id = "fpsCounter";
    this.element.setAttribute("aria-label", "Frames per second");
    this.element.textContent = "-- FPS";
    document.body.appendChild(this.element);
    window.addEventListener("blur", this.resetFrameCadence);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.updateAppearance();
  }

  update(engine: AbstractEngine, scene?: Scene, cpu?: CpuFrameSample): void {
    if (cpu) this.recordCpuSample(cpu, scene);
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
    const intervalAverage = this.sampleCount > 0
      ? this.frameIntervalMilliseconds / this.sampleCount
      : 0;
    const streaming = this.latestStreaming;
    const memory = (performance as MemoryPerformance).memory;
    const config = this.configuration
      ? `scale ${this.configuration.renderScale.toFixed(2)}`
      : "";
    const slow = creationStats.slowOperationsSnapshot();
    this.element.textContent = [
      `${fps}  ${frameMs.toFixed(1)} ms frame`,
      `pacing ${intervalAverage.toFixed(1)} avg / ` +
        `${this.frameIntervalPeakMilliseconds.toFixed(1)} worst ms  ` +
        `${this.stutterCount} hitch${this.stutterCount === 1 ? "" : "es"}`,
      this.unattributedPeakMilliseconds > 0.5
        ? `outside callback ${this.unattributedPeakMilliseconds.toFixed(1)} peak ms`
        : "",
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
      this.benchmark
        ? `benchmark ${this.benchmark.phaseIndex + 1}/${this.benchmark.phases.length}: ` +
          `${this.benchmark.phases[this.benchmark.phaseIndex].name}`
        : "",
      streaming
        ? `stream ${streaming.activeTileBuilds} build  ${streaming.terrainTiles} terrain  ` +
          `${streaming.detailTiles} detail`
        : "",
      [memory ? `${formatBytes(memory.usedJSHeapSize)} heap` : "", config]
        .filter(Boolean)
        .join("  "),
      `\nSlow operations > ${SLOW_OPERATION_THRESHOLD_MS} ms (${slow.sampleCount}/${slow.capacity} retained)`,
      slow.operations.length ? "worst / latest | count | last seen" : "No slow operations recorded",
      ...slow.operations.map((operation) => {
        const ageSeconds = Math.max(0, Math.floor((now - operation.recordedAtMilliseconds) / 1000));
        const name = operation.category.replace(/^streaming\.stage\./, "");
        return `${name}\n  ${operation.maximumMilliseconds.toFixed(1)} / ` +
          `${operation.latestMilliseconds.toFixed(1)} ms | ${operation.count}x | ${ageSeconds}s ago`;
      }),
    ].filter(Boolean).join("\n");
    this.resetInterval();
  }

  toggleExpanded(): void {
    if (this.benchmark) return;
    this.expanded = !this.expanded;
    this.lastUpdate = 0;
    this.updateAppearance();
  }

  startComparativeBenchmark(
    phases: readonly RenderBenchmarkPhase[],
    onComplete: () => void,
  ): boolean {
    if (this.benchmark || phases.length < 2) return false;
    if (!this.expanded) {
      this.expanded = true;
      this.updateAppearance();
    }
    this.benchmarkResults = undefined;
    this.benchmark = {
      phases,
      phaseIndex: 0,
      warmupFrames: BENCHMARK_WARMUP_FRAMES,
      warmupMilliseconds: 0,
      lastGpuSampleCount: this.engineInstrumentation.gpuFrameTimeCounter?.count ?? 0,
      samples: [],
      results: [],
      onComplete,
    };
    phases[0].apply();
    this.lastUpdate = 0;
    return true;
  }

  get benchmarkRunning(): boolean {
    return this.benchmark !== undefined;
  }

  dispose(): void {
    window.removeEventListener("blur", this.resetFrameCadence);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
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

  private recordCpuSample(
    sample: CpuFrameSample,
    scene?: Scene,
  ): void {
    const recordedAtMilliseconds = performance.now();
    const frameIntervalMilliseconds = this.lastFrameRecordedAt === undefined
      ? 0
      : recordedAtMilliseconds - this.lastFrameRecordedAt;
    this.lastFrameRecordedAt = recordedAtMilliseconds;
    if (this.cadenceMilliseconds === undefined && frameIntervalMilliseconds > 0) {
      // Bootstrap from the display cadence without letting a slow startup frame
      // permanently teach the detector that hitches are normal.
      this.cadenceMilliseconds = Math.min(frameIntervalMilliseconds, 1000 / 30);
    }
    const expectedCadenceMilliseconds = this.cadenceMilliseconds ?? 1000 / 60;
    const callbackMilliseconds = sample.gameMilliseconds + sample.renderMilliseconds;
    creationStats.recordSlowOperation("frame.callback", callbackMilliseconds);
    creationStats.recordSlowOperation("frame.game", sample.gameMilliseconds);
    creationStats.recordSlowOperation("frame.render", sample.renderMilliseconds);
    creationStats.recordSlowOperation("frame.vegetation", sample.vegetationMilliseconds);
    const unattributedMilliseconds = Math.max(
      0,
      frameIntervalMilliseconds - expectedCadenceMilliseconds - callbackMilliseconds,
    );
    const frameBudgetMilliseconds = this.frameBudgetMilliseconds();
    const stutter = frameIntervalMilliseconds > frameBudgetMilliseconds;

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
    if (frameIntervalMilliseconds > 0) {
      this.frameIntervalMilliseconds += frameIntervalMilliseconds;
      this.frameIntervalPeakMilliseconds = Math.max(
        this.frameIntervalPeakMilliseconds,
        frameIntervalMilliseconds,
      );
      this.unattributedPeakMilliseconds = Math.max(
        this.unattributedPeakMilliseconds,
        unattributedMilliseconds,
      );
      if (stutter) this.stutterCount++;
      this.updateCadence(frameIntervalMilliseconds, stutter);
    }
    this.latestStreaming = sample;
    const historySample = {
      ...sample,
      recordedAtMilliseconds,
      frameIntervalMilliseconds,
      callbackMilliseconds,
      unattributedMilliseconds,
      frameBudgetMilliseconds,
      stutter,
    };
    if (this.frameHistory.length < FRAME_HISTORY_SIZE) {
      this.frameHistory.push(historySample);
    } else {
      this.frameHistory[this.frameHistoryCursor] = historySample;
    }
    this.frameHistoryCursor = (this.frameHistoryCursor + 1) % FRAME_HISTORY_SIZE;
    this.recordBenchmarkSample(sample, frameIntervalMilliseconds, scene);
  }

  private recordBenchmarkSample(
    sample: CpuFrameSample,
    frameIntervalMilliseconds: number,
    scene?: Scene,
  ): void {
    const benchmark = this.benchmark;
    if (!benchmark || !scene || frameIntervalMilliseconds <= 0) return;
    // Streaming and cross-fades change the workload independently of the
    // feature under test. Wait for them instead of contaminating a phase.
    const gpuCounter = this.engineInstrumentation.gpuFrameTimeCounter;
    const gpuCount = gpuCounter?.count ?? 0;
    const freshGpuSample = gpuCount > benchmark.lastGpuSampleCount;
    benchmark.lastGpuSampleCount = gpuCount;
    if (document.hidden || sample.activeTileBuilds > 0 || (sample.activeLayerFades ?? 0) > 0) {
      benchmark.warmupFrames = BENCHMARK_WARMUP_FRAMES;
      benchmark.warmupMilliseconds = 0;
      benchmark.samples.length = 0;
      return;
    }
    if (benchmark.warmupFrames > 0 || benchmark.warmupMilliseconds < BENCHMARK_WARMUP_MS) {
      benchmark.warmupFrames--;
      benchmark.warmupMilliseconds += frameIntervalMilliseconds;
      return;
    }
    const gpuNanoseconds = freshGpuSample ? gpuCounter?.current ?? 0 : 0;
    benchmark.samples.push({
      frameIntervalMilliseconds,
      gameMilliseconds: sample.gameMilliseconds,
      renderMilliseconds: sample.renderMilliseconds,
      gpuFrameMilliseconds: gpuNanoseconds / 1_000_000,
      drawCalls: this.instrumentation.drawCallsCounter.current,
      activeTriangles: scene.getActiveIndices() / 3,
    });
    if (benchmark.samples.length < BENCHMARK_SAMPLE_FRAMES ||
      benchmark.samples.reduce((sum, entry) => sum + entry.frameIntervalMilliseconds, 0) < BENCHMARK_SAMPLE_MS) return;

    benchmark.results.push(summarizeBenchmarkPhase(
      benchmark.phases[benchmark.phaseIndex].name,
      benchmark.samples,
    ));
    benchmark.results[benchmark.results.length - 1].context =
      benchmark.phases[benchmark.phaseIndex].captureContext?.();
    benchmark.phaseIndex++;
    if (benchmark.phaseIndex < benchmark.phases.length) {
      benchmark.samples = [];
      benchmark.warmupFrames = BENCHMARK_WARMUP_FRAMES;
      benchmark.warmupMilliseconds = 0;
      benchmark.phases[benchmark.phaseIndex].apply();
      this.lastUpdate = 0;
      return;
    }

    this.benchmarkResults = addBenchmarkDeltas(benchmark.results);
    this.benchmark = undefined;
    benchmark.onComplete();
  }

  private frameBudgetMilliseconds(): number {
    const cadence = this.cadenceMilliseconds ?? 1000 / 60;
    return Math.max(cadence * 1.5, cadence + 4);
  }

  private updateCadence(intervalMilliseconds: number, stutter: boolean): void {
    if (stutter || intervalMilliseconds > MAX_CADENCE_SAMPLE_MILLISECONDS) return;
    if (this.cadenceMilliseconds === undefined) {
      this.cadenceMilliseconds = intervalMilliseconds;
      return;
    }
    this.cadenceMilliseconds = this.cadenceMilliseconds * 0.95 + intervalMilliseconds * 0.05;
  }

  private readonly resetFrameCadence = (): void => {
    if (this.benchmark) {
      this.benchmark.warmupFrames = BENCHMARK_WARMUP_FRAMES;
      this.benchmark.warmupMilliseconds = 0;
      this.benchmark.samples.length = 0;
    }
    this.lastFrameRecordedAt = undefined;
    this.cadenceMilliseconds = undefined;
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) this.resetFrameCadence();
  };

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
    this.frameIntervalMilliseconds = 0;
    this.frameIntervalPeakMilliseconds = 0;
    this.unattributedPeakMilliseconds = 0;
    this.stutterCount = 0;
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
    const meshWorkloads = groupMeshWorkloads(meshDetails);
    const renderTargets = scene.textures
      .filter((texture): texture is RenderTargetTexture => texture instanceof RenderTargetTexture)
      .map((texture) => {
        const size = texture.getSize();
        return {
          name: texture.name,
          width: size.width,
          height: size.height,
          samples: texture.samples,
          refreshRate: texture.refreshRate,
          renderListMeshes: texture.renderList?.length ?? null,
          hasActiveCamera: Boolean(texture.activeCamera),
          noPrePassRenderer: texture.noPrePassRenderer,
        };
      });

    const backendInfo = engine as AbstractEngine & {
      getInfo?: () => { vendor: string; renderer: string; version: string };
      webGLVersion?: number;
    };
    return {
      schema: "babylon-earth/render-stats",
      version: REPORT_VERSION,
      streamingDiagnostics: streamingDiagnosticsSnapshot(),
      slowOperations: creationStats.slowOperationsSnapshot(),
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
        pacing: summarizeSamples(
          frameHistory
            .map((sample) => sample.frameIntervalMilliseconds)
            .filter((milliseconds) => milliseconds > 0),
        ),
        callback: summarizeSamples(frameHistory.map((sample) => sample.callbackMilliseconds)),
        unattributed: summarizeSamples(
          frameHistory.map((sample) => sample.unattributedMilliseconds),
        ),
        stutterCount: frameHistory.filter((sample) => sample.stutter).length,
        stutterSamples: frameHistory.filter((sample) => sample.stutter),
        samples: frameHistory,
      },
      comparativeBenchmark: {
        status: this.benchmark ? "running" : this.benchmarkResults ? "complete" : "not-run",
        warmupFramesPerPhase: BENCHMARK_WARMUP_FRAMES,
        sampleFramesPerPhase: BENCHMARK_SAMPLE_FRAMES,
        minimumWarmupMilliseconds: BENCHMARK_WARMUP_MS,
        minimumSampleMilliseconds: BENCHMARK_SAMPLE_MS,
        comparisonMethod: "Each variant compared with its preceding baseline; two rounds in opposite order",
        fpsMethod: "1000 / mean frame interval; other FPS statistics are instantaneous",
        gpuMethod: "Only newly completed GPU queries; asynchronous results may lag rendering",
        snapshotPhase: this.benchmarkResults?.at(-1)?.name,
        recentFramesScope: "Rolling history may include multiple benchmark phases; use phase summaries for comparisons",
        phases: this.benchmarkResults ?? [],
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
        meshWorkloads,
        renderTargets,
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

export function addBenchmarkDeltas(results: RenderBenchmarkResult[]): RenderBenchmarkResult[] {
  let baselinePhaseIndex = 0;
  return results.map((result, index) => {
    if (result.name === "baseline") baselinePhaseIndex = index;
    const baseline = results[baselinePhaseIndex];
    const baselineFps = baseline?.fps?.average;
    const baselineFrame = baseline?.frameInterval?.average;
    const baselineGpu = baseline?.gpuFrame?.average;
    return {
      ...result,
      baselinePhaseIndex,
      relativeToBaseline: {
        averageFpsPercent: percentChange(result.fps?.average, baselineFps),
        averageFrameTimePercent: percentChange(result.frameInterval?.average, baselineFrame),
        averageGpuTimePercent: result.gpuFrame?.average && baselineGpu
          ? percentChange(result.gpuFrame.average, baselineGpu)
          : null,
      },
    };
  });
}

function percentChange(value: number | undefined, baseline: number | undefined): number {
  if (value === undefined || baseline === undefined || baseline === 0) return 0;
  return ((value - baseline) / baseline) * 100;
}

export function summarizeBenchmarkPhase(
  name: string,
  samples: readonly RenderBenchmarkSample[],
): RenderBenchmarkResult {
  const frameIntervals = samples.map((sample) => sample.frameIntervalMilliseconds);
  const frameInterval = summarizeSamples(frameIntervals);
  const fps = summarizeSamples(frameIntervals.map((milliseconds) => 1000 / milliseconds));
  if (fps && frameInterval) fps.average = 1000 / frameInterval.average;
  return {
    name,
    samples: samples.length,
    gpuSamples: samples.filter((sample) => sample.gpuFrameMilliseconds > 0).length,
    frameInterval,
    fps,
    gpuFrame: summarizeSamples(
      samples.map((sample) => sample.gpuFrameMilliseconds).filter((milliseconds) => milliseconds > 0),
    ),
    game: summarizeSamples(samples.map((sample) => sample.gameMilliseconds)),
    renderCall: summarizeSamples(samples.map((sample) => sample.renderMilliseconds)),
    drawCalls: summarizeSamples(samples.map((sample) => sample.drawCalls)),
    activeTriangles: summarizeSamples(samples.map((sample) => sample.activeTriangles)),
  };
}

function groupMeshWorkloads(
  meshes: Array<{
    name: string;
    sourceTriangles: number;
    estimatedRenderedTriangles: number;
    instances: number;
    thinInstances: number;
  }>,
): Array<Record<string, number | string>> {
  const groups = new Map<string, {
    meshes: number;
    sourceTriangles: number;
    estimatedRenderedTriangles: number;
    instances: number;
  }>();
  for (const mesh of meshes) {
    const category = meshCategory(mesh.name);
    const group = groups.get(category) ?? {
      meshes: 0,
      sourceTriangles: 0,
      estimatedRenderedTriangles: 0,
      instances: 0,
    };
    group.meshes++;
    group.sourceTriangles += mesh.sourceTriangles;
    group.estimatedRenderedTriangles += mesh.estimatedRenderedTriangles;
    group.instances += Math.max(1, mesh.instances + mesh.thinInstances);
    groups.set(category, group);
  }
  return [...groups.entries()]
    .map(([category, values]) => ({ category, ...values }))
    .sort((a, b) => b.estimatedRenderedTriangles - a.estimatedRenderedTriangles);
}

function meshCategory(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes("grass")) return "grass";
  if (normalized.includes("tree") || normalized.includes("sapling")) return "trees";
  if (normalized.includes("bush") || normalized.includes("fern") || normalized.includes("plant")) {
    return "undergrowth";
  }
  if (normalized.includes("rock")) return "rocks";
  if (normalized.includes("terrain") || normalized.includes("ground")) return "terrain";
  if (normalized.includes("building")) return "buildings";
  if (normalized.includes("road") || normalized.includes("barrier")) return "map-features";
  if (normalized.includes("water") || normalized.includes("lake")) return "water";
  if (normalized.includes("cloud") || normalized.includes("sky") || normalized.includes("star") ||
      normalized.includes("moon") || normalized.includes("sun") || normalized.includes("fog")) {
    return "sky";
  }
  return "other";
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
