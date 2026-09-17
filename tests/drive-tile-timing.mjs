// Tile build timing measurement (not part of the unit suite).
// Builds the standalone performance fixture, spawns in central Oslo in an
// isolated headless Chrome, lets the world stream in, then teleports east a
// few times so fresh tiles keep building. Writes the session tile timing
// summary and every per-tile console line under artifacts/tile-timing/.
//
//   yarn node tests/drive-tile-timing.mjs [--label=name] [--bundle=<dir>] [--hops=3] [--settle=20]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argument = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const label = argument('label', 'run');
const reuseBundle = argument('bundle');
const hops = Number(argument('hops', 3));
const settleSeconds = Number(argument('settle', 20));
const terrainSize = Number(argument('terrain-size', 33));
const output = reuseBundle ?? mkdtempSync(join(tmpdir(), 'earth-tile-timing-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!reuseBundle) {
  await new Promise((res, rej) => {
    const build = spawn(process.execPath, [
      ...process.execArgv,
      fileURLToPath(new URL('./build-render-performance.mjs', import.meta.url)),
      output,
    ], { stdio: 'inherit', windowsHide: true });
    build.on('error', rej);
    build.on('exit', (code) => (code === 0 ? res() : rej(new Error(`fixture build exited ${code}`))));
  });
}
console.log('Bundle:', output);

const PAGE = '<!doctype html><style>html,body{margin:0;overflow:hidden}canvas{width:997px;height:731px;display:block}</style>'
  + '<canvas id="renderCanvas"></canvas><script src="/fixture.js"></script>';
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(PAGE);
    return;
  }
  try {
    const extension = extname(pathname);
    response.setHeader('Content-Type', extension === '.js' ? 'text/javascript'
      : extension === '.wasm' ? 'application/wasm' : 'image/png');
    response.end(readFileSync(join(output, pathname.slice(1))));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const profileDirectory = mkdtempSync(join(tmpdir(), 'earth-tile-timing-browser-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--remote-debugging-port=0', `--user-data-dir=${profileDirectory}`,
  '--headless=new', '--window-size=1100,850', '--no-first-run',
  '--disable-extensions', '--disable-default-apps',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
], { stdio: 'ignore', windowsHide: true });

const tileLines = [];
const errors = [];
let socket;
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const port = Number(readFileSync(join(profileDirectory, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      const response = await fetch(`http://localhost:${port}/json/new?about:blank`, {
        method: 'PUT', signal: AbortSignal.timeout(2000),
      });
      target = await response.json();
    } catch {
      await sleep(200);
    }
  }
  if (!target) throw new Error('Browser did not start');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = message.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (message.params.type === 'error') {
        errors.push(text);
        console.log('Browser error:', text.slice(0, 400));
      } else if (text.startsWith('[Tile timing]')) {
        tileLines.push(text);
      }
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const requestId = ++id;
    pending.set(requestId, { resolve: res, reject: rej });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  const url = `http://127.0.0.1:${server.address().port}/?oslo-walk&seed=1161908820&clock=manual&date=2026-09-05&time=14&wind-speed=0&terrain-size=${terrainSize}`;
  const navigation = await send('Page.navigate', { url });
  if (navigation.errorText) throw new Error(navigation.errorText);
  const startedAt = Date.now();
  let lastStep;
  for (let i = 0; ; i++) {
    const state = await evaluate('({ready:window.performanceReady,error:window.performanceError,step:window.performanceProgress})');
    if (state.error) throw new Error(state.error);
    if (state.ready) break;
    if (JSON.stringify(state.step) !== lastStep) {
      lastStep = JSON.stringify(state.step);
      console.log(`Loading +${((Date.now() - startedAt) / 1000).toFixed(1)}s`, lastStep);
    }
    if (i > 600) throw new Error('Initialization timed out');
    await sleep(1000);
  }
  const initializationSeconds = (Date.now() - startedAt) / 1000;
  console.log(`Initialized after ${initializationSeconds.toFixed(1)} s`);
  await evaluate('window.performanceGame.sceneControls.setMenuOpen(false); true');
  if (process.argv.includes('--init-only')) {
    for (const line of tileLines) console.log(line.slice(0, 400));
    throw new Error('init-only run complete');
  }

  const tileCount = async () =>
    evaluate('window.performanceTools.tileTimingSummary().tiles.reduce((n, r) => n + r.tiles, 0)');
  const coverage = [];
  const settle = async (phase) => {
    let last = -1;
    let stableFor = 0;
    for (let elapsed = 0; elapsed < 300 && stableFor < settleSeconds; elapsed += 5) {
      await sleep(5000);
      const count = await tileCount();
      const state = await evaluate(`(() => {
        const game = window.performanceGame;
        const tiles = [...game.tiles.values()];
        return { terrain: tiles.length, target: (2 * game.terrainTileRadius + 1) ** 2,
          scenery: tiles.filter(t => t.detailed || (t.farTreeField && t.farBuildings && t.farRoads)).length,
          active: game.activeTileBuilds.size };
      })()`);
      coverage.push({ phase, elapsedSeconds: elapsed + 5, ...state });
      stableFor = count === last ? stableFor + 5 : 0;
      last = count;
      console.log(`${phase} ${elapsed + 5}s: ${count} tile builds, coverage ${JSON.stringify(state)}`);
    }
  };
  await settle('fill');
  // Level-17 tiles are ~305.7 projected meters wide; positions are projected meters / metersPerUnit.
  const hopUnits = await evaluate('6 * 305.75 / window.performanceGame.terrainMetersPerUnit');
  for (let hop = 1; hop <= hops; hop++) {
    await evaluate(`window.performanceGame.flyCamera.position.x += ${hopUnits}; true`);
    await settle(`hop ${hop}`);
  }

  const summary = await evaluate('window.performanceTools.tileTimingSummary()');
  const recentStages = await evaluate('window.performanceTools.streamingDiagnosticsSnapshot().stages');
  const gpu = await evaluate('window.performanceGame.engine.getInfo()');
  // Frame pacing seen by the game loop: what the adaptive streaming budget resolved to.
  const frames = await evaluate(`(() => {
    const game = window.performanceGame;
    const counter = game.fpsCounter;
    const samples = Math.max(1, counter.sampleCount ?? 0);
    return {
      samples,
      averageGameMs: (counter.gameMilliseconds ?? 0) / samples,
      averageRenderMs: (counter.renderMilliseconds ?? 0) / samples,
      averageIntervalMs: (counter.frameIntervalMilliseconds ?? 0) / samples,
      frameIntervalEstimateMs: game.frameIntervalEstimateMilliseconds,
      frameCallbackEstimateMs: game.frameCallbackEstimateMilliseconds,
      streamingBudgetMs: game.streamingBudgetMilliseconds,
    };
  })()`);
  console.log('Frame pacing:', JSON.stringify(frames));
  const directory = resolve('artifacts', 'tile-timing');
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(directory, `${label}-${stamp}.json`);
  writeFileSync(file, JSON.stringify({
    label, url, bundle: output, initializationSeconds, coverage, summary, recentStages, tileLines, errors, gpu, frames,
  }, null, 2));
  console.log('\nTile totals:');
  console.table(summary.tiles);
  console.log('Top stages by total wall-clock time:');
  console.table(summary.stages.slice(0, 25));
  console.log('Top blocking stages:');
  console.table(summary.stages.filter((s) => s.kind === 'blocking').slice(0, 15));
  console.log('Written:', file, `(${errors.length} browser errors)`);
} finally {
  socket?.close();
  chrome.kill();
  server.close();
}
