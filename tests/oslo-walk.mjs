import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { freemem, totalmem } from 'node:os';

// Runs inside the fixture's page. Preserve the normal Game.run callback and all
// movement, collisions, rendering, LOD and streaming; only supply held W input.
function startWalk() {
  const g = window.performanceGame;
  const c = g.flyCamera;
  g.sceneControls.setMenuOpen(false);
  c.rotation.set(0, -Math.PI / 2, 0);
  if (g.playerControls.movementMode !== 'walk') g.playerControls.toggleMovementMode();
  const start = c.position.clone();
  const started = performance.now();
  performance.mark('oslo-walk-start');
  const frames = [], longTasks = [];
  const shaderEvents = [];
  const knownEffects = new Set(Object.values(g.engine._compiledEffects));
  const createEffect = g.engine.createEffect;
  g.engine.createEffect = function (...args) {
    const effect = createEffect.apply(this, args);
    if (!knownEffects.has(effect)) {
      knownEffects.add(effect);
      const shader = args[0];
      shaderEvents.push({ time: performance.now(), shader: typeof shader === 'string' ? shader : {
        vertex: shader.vertex ?? shader.vertexElement ?? '(inline)',
        fragment: shader.fragment ?? shader.fragmentElement ?? '(inline)',
      }, defines: args[1]?.defines ?? args[4] });
    }
    return effect;
  };
  const observer = new PerformanceObserver(list => {
    for (const e of list.getEntries()) longTasks.push(e.toJSON());
  });
  observer.observe({ type: 'longtask', buffered: false });
  let previous = started, lastProgress = started, furthest = 0;
  const original = g.fpsCounter.update;
  window.walkProgress = { distance: 0 };
  g.playerControls.heldMovementKeys.add('w');
  g.fpsCounter.update = function (...args) {
    original.apply(this, args);
    const now = performance.now();
    const distance = Math.hypot(c.position.x - start.x, c.position.z - start.z) * g.terrainMetersPerUnit;
    if (distance > furthest + 0.5) { furthest = distance; lastProgress = now; }
    const index = (this.frameHistoryCursor + this.frameHistory.length - 1) % this.frameHistory.length;
    frames.push({ ...this.frameHistory[index], interval: now - previous, distance, position: c.position.asArray() });
    previous = now;
    window.walkProgress = { distance, frames: frames.length, elapsed: now - started };
    if (distance >= 100 || now - started > 180000 || now - lastProgress > 10000) {
      performance.mark('oslo-walk-end');
      g.playerControls.heldMovementKeys.clear();
      g.fpsCounter.update = original;
      g.engine.createEffect = createEffect;
      observer.disconnect();
      window.walkResult = {
        completed: distance >= 100, started, finished: now, distance,
        spawn: { lat: 59.9116, lon: 10.7334 }, yaw: -Math.PI / 2,
        metersPerUnit: g.terrainMetersPerUnit, start: start.asArray(), end: c.position.asArray(),
        settings: g.sceneSettings.value, gpu: g.engine.getInfo(),
        browser: navigator.userAgent, devicePixelRatio,
        renderSize: [g.engine.getRenderWidth(), g.engine.getRenderHeight()],
        visibility: document.visibilityState, focused: document.hasFocus(),
        frames, longTasks, shaderEvents, streaming: window.performanceTools.streamingDiagnosticsSnapshot(),
        report: g.fpsCounter.createRenderStatsReport(g.engine, g.scene, g.getRenderStatsContext()),
      };
    }
  };
}

export async function runOsloWalk({ evaluate, send, output, errors, browserLog, readTrace }) {
  const threshold = Number(process.argv.find(a => a.startsWith('--max-frame-ms='))?.split('=')[1] ?? (1000 / 30));
  if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('Invalid --max-frame-ms');
  const directory = resolve('artifacts', 'oslo-walk', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(directory, { recursive: true });
  console.log('Oslo walk results:', directory);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    for (let i = 0; i < 600; i++) {
      const state = await evaluate(`({ready:window.performanceReady,error:window.performanceError,step:window.performanceProgress})`);
      if (state.error) throw new Error(state.error);
      if (state.ready) break;
      if (i % 15 === 0) console.log('Loading Oslo', state);
      if (i === 599) throw new Error('Oslo initialization timed out');
      await sleep(1000);
    }
    // No settling delay: capture streaming that continues after the player spawns.
    const host = { totalMemoryBytes: totalmem(), freeMemoryBeforeWalkBytes: freemem(),
      driverHeapBeforeWalkBytes: process.memoryUsage().heapUsed, node: process.version };
    if (process.argv.includes('--trace')) {
      const categories = ['devtools.timeline', 'v8', 'blink', 'blink.user_timing', 'cc', 'gpu'];
      if (process.argv.includes('--trace-gpu')) {
        const available = await send('Tracing.getCategories');
        const detail = available.categories.filter(name => /gpu.*(service|debug)|gpu_cmd|gpu\.angle/.test(name));
        console.log('Detailed GPU trace categories:', detail);
        categories.push(...detail);
      }
      await send('Tracing.start', { categories: categories.join(','), transferMode: 'ReturnAsStream' });
    }
    if (process.argv.includes('--profile')) {
      await send('Profiler.enable');
      await send('Profiler.setSamplingInterval', { interval: 1000 });
      await send('Profiler.start');
    }
    await evaluate(`(${startWalk.toString()})()`);
    let result, traceStoppedAtMilliseconds;
    for (let i = 0; i < 210; i++) {
      const state = await evaluate('({done:!!window.walkResult,progress:window.walkProgress})');
      // Per-GL-call events are voluminous. Restrict that optional diagnostic to
      // the early pauses while retaining frame measurements for the whole walk.
      if (process.argv.includes('--trace') && process.argv.includes('--trace-gpu') &&
          traceStoppedAtMilliseconds === undefined && state.progress?.elapsed >= 2000) {
        await send('Tracing.end');
        traceStoppedAtMilliseconds = state.progress.elapsed;
      }
      if (state.done) { result = await evaluate('window.walkResult'); break; }
      if (i % 10 === 0) console.log('Walking', state.progress);
      await sleep(1000);
    }
    if (process.argv.includes('--profile')) {
      const { profile } = await send('Profiler.stop');
      writeFileSync(join(directory, 'walk.cpuprofile'), JSON.stringify(profile));
    }
    if (!result) throw new Error('Walk timed out');
    const intervals = result.frames.map(f => f.interval).sort((a,b) => a-b);
    const percentile = p => intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * p))];
    result.summary = {
      completed: result.completed, distanceMeters: result.distance, frames: intervals.length,
      durationSeconds: (result.finished - result.started) / 1000,
      p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: intervals.at(-1),
      over33ms: intervals.filter(t => t > 1000 / 30).length,
      over50ms: intervals.filter(t => t > 50).length,
      over100ms: intervals.filter(t => t > 100).length,
      detectedStutters: result.frames.filter(f => f.stutter).length,
      frameLimitMilliseconds: threshold,
      framesOverLimit: intervals.filter(t => t > threshold).length,
      passed: result.completed && intervals.every(t => t <= threshold) && errors.length === 0 && result.focused && result.visibility === 'visible',
    };
    writeFileSync(join(directory, 'results.json'), JSON.stringify({ ...result, errors,
      host: { ...host, freeMemoryAfterWalkBytes: freemem() }, traceStoppedAtMilliseconds,
      arguments: process.argv.slice(2), buildDirectory: output }, null, 2));
    // Preserve the measurement even if optional tracing or screenshot capture fails.
    if (process.argv.includes('--trace')) writeFileSync(join(directory, 'trace.json'), await readTrace(traceStoppedAtMilliseconds === undefined));
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(directory, 'finish.png'), Buffer.from(screenshot.data, 'base64'));
    console.log('Walk summary:', JSON.stringify(result.summary));
    if (!result.completed) throw new Error('Route blocked: did not walk 100 meters');
    if (errors.length) throw new Error('Browser errors invalidated this run; inspect results.json');
    if (!result.summary.passed) throw new Error(`Stutter regression: ${result.summary.framesOverLimit} frames exceeded ${threshold.toFixed(2)} ms; inspect results.json`);
  } catch (error) {
    writeFileSync(join(directory, 'failure.json'), JSON.stringify({ message: String(error?.stack ?? error) }, null, 2));
    throw error;
  } finally {
    writeFileSync(join(directory, 'errors.json'), JSON.stringify(errors, null, 2));
    if (browserLog && existsSync(browserLog)) copyFileSync(browserLog, join(directory, 'browser.log'));
  }
}
