// Isolated real-WebGL reproduction. No access to the user's Chrome profile.
// yarn node tests/drive-render-corruption.mjs
// PowerShell pixel/context-restoration check:
// $env:EARTH_FIXTURE='tests/fixtures/render-resource-pixels.ts'; yarn node tests/drive-render-corruption.mjs
// EARTH_FAST_CAPTURE=1 reduces atlas quality for quicker full-world stress runs.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import webpack from 'webpack';

const output = mkdtempSync(join(tmpdir(), 'earth-render-corruption-'));
console.log('Artifacts:', output);
const compiler = webpack({ mode: 'development', devtool: false,
  entry: join(process.cwd(), process.env.EARTH_FIXTURE ?? 'tests/fixtures/performance-scene.ts'),
  output: { path: output, filename: 'fixture.js' },
  resolve: { extensions: ['.ts', '.js'] },
  module: { rules: [
    { test: /\.ts$/, use: { loader: 'ts-loader', options: { transpileOnly: true, compilerOptions: { rootDir: process.cwd() } } } },
    { test: /\.png$/, type: 'asset/resource' },
    { test: /\.wasm$/, type: 'asset/resource', generator: { filename: 'lerc-wasm.wasm' } },
  ] },
});
await new Promise((resolve, reject) => compiler.run((error, stats) => {
  compiler.close(() => {});
  if (error || stats.hasErrors()) reject(error ?? new Error(stats.toString('errors-only')));
  else resolve();
}));
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><style>body{margin:0}canvas{width:960px;height:600px}</style><canvas id="renderCanvas"></canvas><script src="/fixture.js"></script>');
  } else {
    try {
      response.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : extname(path) === '.wasm' ? 'application/wasm' : 'image/png');
      response.end(readFileSync(join(output, path.slice(1))));
    } catch { response.writeHead(404); response.end(); }
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = Number(process.env.EARTH_DEBUG_PORT ?? 9373);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--remote-debugging-port=${port}`, `--user-data-dir=${output}/profile`,
  '--headless=new', '--window-size=1000,700', '--no-first-run',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
], { stdio: 'ignore', windowsHide: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const logs = [];
let socket;
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://localhost:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('Chrome failed to start');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    else if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Runtime.exceptionThrown' || m.method === 'Log.entryAdded') {
      logs.push(m);
      if (m.method === 'Runtime.exceptionThrown' || m.params.type === 'error') console.log('Browser error:', JSON.stringify(m.params).slice(0, 2200));
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => { pending.delete(current); reject(new Error(`Timed out: ${method}`)); }, 45000);
    pending.set(current, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id: current, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('earth.location.v1', JSON.stringify({lat:59.905,lon:10.735}));` });
  const captureQuery=process.env.EARTH_FAST_CAPTURE ? ['tree-impostor','grass-impostor','bush-impostor','fern-impostor','tall-plant-impostor','wheat-impostor','rocky-beach-impostor']
    .map(prefix=>`&${prefix}-x-samples=2&${prefix}-y-samples=2&${prefix}-resolution=48`).join('') : '';
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/?terrain-size=3&detail-size=1&clock=manual&date=2026-09-05&time=14${captureQuery}${process.env.EARTH_QUERY ?? ''}` });
  const iterations=Number(process.env.EARTH_ITERATIONS ?? 180);
  let readyIterations=0;
  for (let i = 0; i < iterations; i++) {
    const state = await evaluate(`(()=>{const g=window.performanceGame;return {ready:window.performanceReady,error:window.performanceError,step:window.performanceProgress,done:window.pixelComplete,pixelError:window.pixelError,results:window.pixelResults,tiles:g?.tiles?.size,builds:g?.activeTileBuilds?.size,frame:g?.scene.getFrameId(),textures:g?.scene.textures.length};})()`);
    if (i % 10 === 0) { console.log('State:', JSON.stringify(state)); writeFileSync(join(output, 'logs.json'), JSON.stringify(logs)); }
    if (state.error || state.pixelError) throw new Error(state.error ?? state.pixelError);
    if (state.done) { console.log('Results:', JSON.stringify(state.results)); break; }
    if (state.ready) {
      readyIterations++;
      await evaluate(`(()=>{
        const g=window.performanceGame;
        if(window.route===undefined){window.route=0;window.reproOrigin=g.flyCamera.position.clone();g.flyCamera.detachControl();g.flyCamera.rotation.x=0.08;}
        g.solarLighting.setTimeOfDay([14,22,7,12][Math.floor(window.route/5)%4]);
        if(window.route%10===0){
          g.flyCamera.position.x=window.reproOrigin.x+Math.sin(window.route/20)*g.tiles.values().next().value.meshWidth*1.5;
          g.flyCamera.position.z=window.reproOrigin.z+Math.cos(window.route/20)*g.tiles.values().next().value.meshDepth*1.5;
        }
        const ground=g.getGroundEyeHeight(g.flyCamera.position.x,g.flyCamera.position.z);
        if(Number.isFinite(ground))g.flyCamera.position.y=ground+0.1;
        if(!g.flyCamera.position.asArray().every(Number.isFinite))throw new Error('Invalid reproduction camera');
        window.route++;
      })()`);
    }
    if (i % 30 === 0) { const shot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(output, `frame-${i}.png`), Buffer.from(shot.data, 'base64')); }
    if (i === iterations-1) {
      const errors=logs.filter(m=>m.method==='Runtime.exceptionThrown'||
        (m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')||
        (m.method==='Log.entryAdded'&&/GL_INVALID|WebGL.*(error|lost|Mismatch)/i.test(m.params.entry.text)));
      console.log('Route verification:',JSON.stringify({readyIterations,errors:errors.length}));
      if(readyIterations<30)throw new Error('World did not run enough route steps');
      if(errors.length)throw new Error(JSON.stringify(errors[0]));
    }
    await sleep(1000);
  }
} finally {
  writeFileSync(join(output, 'logs.json'), JSON.stringify(logs, null, 2));
  socket?.close(); chrome.kill(); server.close();
}
