import { Game } from './Game';
import { TreeImpostorDemo } from './TreeImpostorDemo';
import { TreeImpostorValidation } from './TreeImpostorValidation';

// Wait for DOM to be ready
window.addEventListener('DOMContentLoaded', () => {
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
  const game = isTreeImpostorTest
    ? new TreeImpostorValidation(canvas)
    : isTreeImpostorDemo
      ? new TreeImpostorDemo(canvas)
      : new Game(canvas);

  if (isTreeImpostorDemo || isTreeImpostorTest) {
    document.getElementById('attribution')?.remove();
  }

  const updateLoadingProgress = (step: string, progress: number): void => {
    const normalizedProgress = Math.max(0, Math.min(100, progress));
    if (loadingText) loadingText.textContent = step;
    if (loadingProgressBar) loadingProgressBar.style.width = `${normalizedProgress}%`;
    if (loadingProgress) loadingProgress.setAttribute('aria-valuenow', String(normalizedProgress));
  };

  game.initialize(updateLoadingProgress).then(() => {
    // Hide loading screen
    if (loading) {
      loading.classList.add('hidden');
      setTimeout(() => {
        loading.remove();
      }, 500);
    }

    // Start the render loop
    game.run();
  }).catch((error) => {
    console.error('Failed to initialize game:', error);
    loading?.classList.add('error');
    if (loadingText) loadingText.textContent = 'Unable to load the world';
    loadingProgress?.setAttribute('aria-valuetext', 'Initialization failed');
  });

  // Handle window resize
  window.addEventListener('resize', () => {
    game.resize();
  });
});
