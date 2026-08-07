import { Game } from './Game';
import { TreeImpostorDemo } from './TreeImpostorDemo';

// Wait for DOM to be ready
window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
  const loading = document.getElementById('loading');

  if (!canvas) {
    console.error('Canvas element not found!');
    return;
  }

  const isTreeImpostorDemo = new URLSearchParams(window.location.search).has('tree-impostor');
  const game = isTreeImpostorDemo ? new TreeImpostorDemo(canvas) : new Game(canvas);

  if (isTreeImpostorDemo) {
    document.getElementById('attribution')?.remove();
  }

  game.initialize().then(() => {
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
  });

  // Handle window resize
  window.addEventListener('resize', () => {
    game.resize();
  });
});
