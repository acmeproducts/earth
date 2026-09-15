// Full application exposed only by the standalone performance test bundle.
import { Game } from '../../src/app/Game';
import { createRenderingEngine } from '../../src/rendering/Renderer';
import { EngineInstrumentation, PassPostProcess, ShadowGenerator } from '@babylonjs/core';

const probe = window as any;
void (async () => {
  const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
  const { engine } = await createRenderingEngine(canvas, 'webgl', {
    antialias: !new URLSearchParams(location.search).has('no-aa'), stencil: false,
  });
  const game = new Game(canvas, engine);
  probe.performanceGame = game;
  probe.performanceTools = { EngineInstrumentation, PassPostProcess, ShadowGenerator };
  await game.initialize((step) => { probe.performanceProgress = step; });
  document.getElementById('loading')?.remove();
  game.run();
  probe.performanceReady = true;
})().catch(error => { probe.performanceError = String(error?.stack ?? error); });
