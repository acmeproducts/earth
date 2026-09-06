import { Game } from './Game';
import { LoadingActors } from './LoadingActors';
import {
  createRenderingEngine,
  requestedRenderer,
  RenderingEngineOptions,
} from './Renderer';
import { TreeImpostorDemo } from './TreeImpostorDemo';
import { TreeImpostorValidation } from './TreeImpostorValidation';

// Wait for DOM to be ready
window.addEventListener('DOMContentLoaded', () => {
  void startApplication();
});

async function startApplication(): Promise<void> {
  const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
  const loading = document.getElementById('loading');
  const loadingText = loading?.querySelector<HTMLElement>('.loader-text');
  const loadingProgress = loading?.querySelector<HTMLElement>('.loader-progress');
  const loadingProgressBar = loading?.querySelector<HTMLElement>('.loader-progress-bar');
  const loadingPercent = loading?.querySelector<HTMLElement>('.loader-percent');
  loading?.querySelector<HTMLButtonElement>('.loader-retry')?.addEventListener('click', () => {
    window.location.reload();
  });

  if (!canvas) {
    console.error('Canvas element not found!');
    return;
  }

  const query = new URLSearchParams(window.location.search);
  const isTreeImpostorTest = query.has('tree-impostor-test');
  const isTreeImpostorDemo = query.has('tree-impostor');
  if (isTreeImpostorDemo || isTreeImpostorTest) {
    document.getElementById('attribution')?.remove();
  }

  const updateLoadingProgress = (step: string, progress: number): void => {
    const normalizedProgress = Math.max(0, Math.min(100, progress));
    if (loadingText) loadingText.textContent = step;
    if (loadingProgressBar) loadingProgressBar.style.width = `${normalizedProgress}%`;
    if (loadingProgress) loadingProgress.setAttribute('aria-valuenow', String(normalizedProgress));
    if (loadingPercent) loadingPercent.textContent = `${Math.round(normalizedProgress)}%`;
  };

  const engineOptions: RenderingEngineOptions = isTreeImpostorTest
    ? { preserveDrawingBuffer: true, stencil: true, antialias: false }
    : isTreeImpostorDemo
      ? { preserveDrawingBuffer: true, stencil: false, antialias: true }
      // Scene AA is controlled through render targets so it can change live.
      : { preserveDrawingBuffer: false, stencil: false, antialias: false };

  let loadingActors: LoadingActors | undefined;
  const actorCanvas = loading?.querySelector<HTMLCanvasElement>('.loader-actor');
  const actorCaption = loading?.querySelector<HTMLElement>('.loader-actor-caption');
  if (actorCanvas && actorCaption) {
    try {
      loadingActors = new LoadingActors(actorCanvas, actorCaption);
    } catch (error) {
      console.warn('Loading actor preview unavailable:', error);
    }
  }

  try {
    const backend = requestedRenderer(query);
    updateLoadingProgress(`Starting ${backend === 'webgpu' ? 'WebGPU' : 'WebGL'}`, 1);
    const rendering = await createRenderingEngine(canvas, backend, engineOptions);
    const activeCanvas = rendering.canvas;
    const engine = rendering.engine;
    const game = isTreeImpostorTest
      ? new TreeImpostorValidation(engine)
      : isTreeImpostorDemo
        ? new TreeImpostorDemo(activeCanvas, engine)
        : new Game(activeCanvas, engine);

    await game.initialize(updateLoadingProgress);
    // Hide loading screen
    if (loading) {
      loading.classList.add('hidden');
      setTimeout(() => {
        loadingActors?.dispose();
        loading.remove();
      }, 500);
    }

    // Start the render loop
    game.run();

    // Handle window resize
    window.addEventListener('resize', () => {
      game.resize();
    });
  } catch (error) {
    loadingActors?.dispose();
    console.error('Failed to initialize game:', error);
    loading?.classList.add('error');
    if (loadingText) loadingText.textContent = 'Unable to load the world';
    loadingProgress?.setAttribute('aria-valuetext', 'Initialization failed');
  }
}
