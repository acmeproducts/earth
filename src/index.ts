import { Game } from './Game';
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
  };

  const engineOptions: RenderingEngineOptions = isTreeImpostorTest
    ? { preserveDrawingBuffer: true, stencil: true, antialias: false }
    : isTreeImpostorDemo
      ? { preserveDrawingBuffer: true, stencil: false, antialias: true }
      : { preserveDrawingBuffer: false, stencil: false, antialias: true };

  try {
    const backend = requestedRenderer(query);
    updateLoadingProgress(`Starting ${backend === 'webgpu' ? 'WebGPU' : 'WebGL'}`, 1);
    const rendering = await createRenderingEngine(canvas, backend, engineOptions);
    const activeCanvas = rendering.canvas;
    const engine = rendering.engine;
    const game = isTreeImpostorTest
      ? new TreeImpostorValidation(activeCanvas, engine)
      : isTreeImpostorDemo
        ? new TreeImpostorDemo(activeCanvas, engine)
        : new Game(activeCanvas, engine);

    await game.initialize(updateLoadingProgress);
    // Hide loading screen
    if (loading) {
      loading.classList.add('hidden');
      setTimeout(() => {
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
    console.error('Failed to initialize game:', error);
    loading?.classList.add('error');
    if (loadingText) loadingText.textContent = 'Unable to load the world';
    loadingProgress?.setAttribute('aria-valuetext', 'Initialization failed');
  }
}
