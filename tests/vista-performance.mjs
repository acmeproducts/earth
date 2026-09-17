import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function startVista(seconds) {
  const game = window.performanceGame;
  game.sceneControls.setMenuOpen(false);
  const frames = [], coverage = [], longTasks = [];
  const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.toJSON())));
  observer.observe({ type: 'longtask', buffered: false });
  const started = performance.now();
  let previous = started, nextSample = started;
  const original = game.fpsCounter.update;
  game.fpsCounter.update = function (...args) {
    original.apply(this, args);
    const now = performance.now();
    const index = (this.frameHistoryCursor + this.frameHistory.length - 1) % this.frameHistory.length;
    frames.push({ ...this.frameHistory[index], interval: now - previous, elapsed: now - started });
    previous = now;
    if (now >= nextSample) {
      const tiles = [...game.tiles.values()];
      coverage.push({ elapsed: now - started, terrain: tiles.length,
        scenery: tiles.filter(t => t.detailed || (t.farTreeField && t.farBuildings && t.farRoads)).length,
        activeBuilds: game.activeTileBuilds.size, meshes: game.scene.meshes.length,
        activeMeshes: game.scene.getActiveMeshes().length,
        draws: game.engine._drawCalls.current, triangles: game.scene.getActiveIndices() / 3 });
      nextSample = now + 1000;
      window.vistaProgress = coverage.at(-1);
    }
    if (now - started >= seconds * 1000) {
      game.fpsCounter.update = original;
      observer.disconnect();
      window.vistaResult = { frames, coverage, longTasks, started, finished: now,
        settings: game.sceneSettings.value, gpu: game.engine.getInfo(),
        focused: document.hasFocus(), visibility: document.visibilityState,
        renderSize: [game.engine.getRenderWidth(), game.engine.getRenderHeight()],
        streaming: window.performanceTools.tileTimingSummary(),
        report: this.createRenderStatsReport(game.engine, game.scene, game.getRenderStatsContext()) };
    }
  };
}

function summarize(frames) {
  const sorted = frames.map(f => f.interval).sort((a, b) => a - b);
  const mean = field => frames.reduce((sum, f) => sum + f[field], 0) / frames.length;
  const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { frames: frames.length, fps: 1000 / mean('interval'), p50: percentile(.5),
    p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1),
    over33ms: sorted.filter(t => t > 1000 / 30).length,
    over50ms: sorted.filter(t => t > 50).length,
    gameMs: mean('gameMilliseconds'), renderMs: mean('renderMilliseconds') };
}

export async function runVistaPerformance({ evaluate, send, output, errors }) {
  const seconds = Number(process.argv.find(a => a.startsWith('--seconds='))?.slice(10) ?? 300);
  if (!Number.isFinite(seconds) || seconds < 10) throw new Error('Invalid test duration');
  const directory = resolve('artifacts/vista-performance', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(directory, { recursive: true });
  console.log('Vista results:', directory);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; ; i++) {
    const state = await evaluate('({ready:window.performanceReady,error:window.performanceError,step:window.performanceProgress})');
    if (state.error) throw new Error(state.error);
    if (state.ready) break;
    if (i % 15 === 0) console.log('Loading', state.step);
    if (i > 240) throw new Error('Initialization timed out');
    await sleep(1000);
  }
  if (process.argv.includes('--profile')) {
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: 1000 });
    await send('Profiler.start');
  }
  await evaluate(`(${startVista.toString()})(${seconds})`);
  let result;
  for (let i = 0; i < seconds + 60; i++) {
    const state = await evaluate('({done:!!window.vistaResult,progress:window.vistaProgress})');
    if (state.done) { result = await evaluate('window.vistaResult'); break; }
    if (i % 15 === 0) console.log('Vista', state.progress);
    await sleep(1000);
  }
  if (!result) throw new Error('Vista test timed out');
  if (process.argv.includes('--profile')) {
    const { profile } = await send('Profiler.stop');
    writeFileSync(join(directory, 'vista.cpuprofile'), JSON.stringify(profile));
  }
  const target = result.settings.terrainTilesAcross ** 2;
  const terrainReady = result.coverage.find(sample => sample.terrain >= target)?.elapsed;
  const sceneryReady = result.coverage.find(sample => sample.scenery >= target)?.elapsed;
  result.summary = { all: summarize(result.frames),
    last30Seconds: summarize(result.frames.filter(f => f.elapsed >= (seconds - 30) * 1000)),
    terrainReadySeconds: terrainReady === undefined ? null : terrainReady / 1000,
    sceneryReadySeconds: sceneryReady === undefined ? null : sceneryReady / 1000,
    populated: sceneryReady === undefined ? null : summarize(result.frames.filter(f => f.elapsed >= sceneryReady)),
    finalCoverage: result.coverage.at(-1) };
  result.checks = {
    noBrowserErrors: errors.length === 0,
    foreground: result.focused && result.visibility === 'visible',
    streamingFrameTime: result.summary.all.p95 <= 1000 / 30,
    finalFrameTime: result.summary.last30Seconds.p95 <= 1000 / 30,
    populatedFrameTime: result.summary.populated !== null && result.summary.populated.p95 <= 1000 / 30,
    fullTerrain: result.summary.finalCoverage.terrain >= target,
    fullScenery: result.summary.finalCoverage.scenery >= target,
  };
  result.passed = Object.values(result.checks).every(Boolean);
  writeFileSync(join(directory, 'results.json'), JSON.stringify({ ...result, errors, buildDirectory: output }, null, 2));
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(directory, 'finish.png'), Buffer.from(screenshot.data, 'base64'));
  console.log('Vista summary:', JSON.stringify(result.summary), 'passed:', result.passed);
  if (!result.passed) throw new Error('Vista performance test failed; inspect results.json');
}
