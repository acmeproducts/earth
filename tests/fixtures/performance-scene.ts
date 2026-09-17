// Full application exposed only by the standalone performance test bundle.
import { Game } from '../../src/app/Game';
import { createRenderingEngine } from '../../src/rendering/Renderer';
import { EngineInstrumentation, PassPostProcess, ShadowGenerator } from '@babylonjs/core';
import { streamingDiagnosticsSnapshot, tileTimingSummary } from '../../src/diagnostics/StreamingDiagnostics';

const probe = window as any;
void (async () => {
  const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
  const { engine } = await createRenderingEngine(canvas, 'webgl', {
    antialias: !new URLSearchParams(location.search).has('no-aa'), stencil: false,
  });
  const game = new Game(canvas, engine);
  if (new URLSearchParams(location.search).has('oslo-walk')) {
    (game as any).worldLocation.requestDestination({ lat: 59.9116, lon: 10.7334 });
  }
  probe.performanceGame = game;
  probe.performanceTools = { EngineInstrumentation, PassPostProcess, ShadowGenerator, streamingDiagnosticsSnapshot, tileTimingSummary };
  await game.initialize((step) => {
    probe.performanceProgress = step;
    if (new URLSearchParams(location.search).has('oslo-walk')) {
      // Spawn facing the route; do not introduce a camera turn at walk start.
      (game as any).flyCamera?.rotation.set(0, -Math.PI / 2, 0);
    }
  });
  document.getElementById('loading')?.remove();
  game.run();
  probe.performanceReady = true;
})().catch(error => { probe.performanceError = String(error?.stack ?? error); });
