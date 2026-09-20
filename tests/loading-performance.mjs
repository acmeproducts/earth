import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runLoadingPerformance({ evaluate, send, output, errors }) {
  const seconds = Number(process.argv.find(a => a.startsWith('--seconds='))?.slice(10) ?? 1200);
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error('--seconds must be a positive integer');
  const samples = [];
  let settledAt;
  let state;
  const deadline = Date.now() + seconds * 1000;
  for (let i = 0; Date.now() < deadline; i++) {
    state = await evaluate(`(() => {
      const g = window.performanceGame;
      if (!g) return {error: window.performanceError};
      const tiles = [...g.tiles.values()];
      return {elapsed: performance.now(), ready: !!window.performanceReady,
        error: window.performanceError, step: window.performanceProgress,
        settings: g.sceneSettings.value, location: g.worldLocation.value,
        active: g.activeTileBuilds.size, fades: g.layerFades.size, tiles: tiles.length,
        coverage: window.performanceTools.loadingCoverage?.(),
        scenery: tiles.filter(t => t.detailed || (t.farTreeField && t.farBuildings && t.farRoads)).length,
        diagnostics: window.performanceTools.streamingDiagnosticsSnapshot().activeStages};
    })()`);
    samples.push(state);
    if (i % 10 === 0) console.log('Loading:', JSON.stringify(state));
    if (state.error) break;
    // The streaming scheduler checks every 100 ms. Require several idle checks,
    // including complete far scenery, to avoid counting an empty build slot.
    if (state.ready && state.active === 0 && state.fades === 0 && state.coverage?.expected > 0 &&
        state.coverage.complete === state.coverage.expected && state.scenery === state.tiles) {
      settledAt ??= state.elapsed;
      if (state.elapsed - settledAt >= 3000) break;
    } else settledAt = undefined;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const diagnostics = await evaluate('window.performanceTools?.tileTimingSummary()');
  const inputs = await evaluate('window.loadingWorkerInputs');
  writeFileSync(join(output, 'loading-worker-inputs.json'), JSON.stringify(inputs));
  const result = {complete: settledAt !== undefined && state.elapsed - settledAt >= 3000,
    loadedMilliseconds: settledAt ?? null, settings: state.settings, location: state.location,
    samples, diagnostics, errors};
  writeFileSync(join(output, 'loading.json'), JSON.stringify(result, null, 2));
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, 'loading.png'), Buffer.from(screenshot.data, 'base64'));
  console.log('Loading result:', JSON.stringify({ ...result, samples: undefined, diagnostics: undefined }));
  if (!result.complete || errors.length) throw new Error('Scene did not load completely without errors');
}
