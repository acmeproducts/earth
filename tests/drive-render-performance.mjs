// Isolated headless Chrome profile: does not connect to the user's browser.
// yarn node tests/drive-render-performance.mjs [--no-aa] [--uncapped]
// yarn node tests/drive-render-performance.mjs --pixels
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOsloWalk } from './oslo-walk.mjs';
import { runVistaPerformance } from './vista-performance.mjs';
import { runMemorySoak } from './memory-soak.mjs';

const reuseBundle = process.argv.find(a => a.startsWith('--bundle='))?.slice(9);
const output = reuseBundle ?? mkdtempSync(join(tmpdir(), 'earth-render-perf-'));
const floorStreaming = process.argv.includes('--floor-streaming');
const pixelTest = process.argv.includes('--pixels') || floorStreaming;
const osloWalk = process.argv.includes('--oslo-walk');
const vista = process.argv.includes('--vista');
const memorySoak = process.argv.includes('--memory-soak');
// --snapshot: settle the world, save one screenshot and the browser errors, exit.
const snapshot = process.argv.includes('--snapshot');
const sceneDate = process.argv.find(a => a.startsWith('--date='))?.slice(7) ?? '2026-09-05';
// --fixture=<query>: replaces the default 3x3 tile fixture query for --snapshot (e.g. oslo-walk).
const snapshotFixture = process.argv.find(a => a.startsWith('--fixture='))?.slice(10);
const heapMegabytes = process.argv.find(a => a.startsWith('--heap-mb='))?.slice(10);
if (heapMegabytes !== undefined && (!/^\d+$/.test(heapMegabytes) || Number(heapMegabytes) < 128)) {
  throw new Error('--heap-mb must be an integer of at least 128');
}
console.log('Artifacts:', output);
if (!reuseBundle) await new Promise((resolve, reject) => {
  const build = spawn(process.execPath, [
    ...process.execArgv,
    fileURLToPath(new URL('./build-render-performance.mjs', import.meta.url)), output,
    ...(pixelTest ? ['--pixels'] : []),
    ...(floorStreaming ? ['--floor-streaming'] : []),
  ], { stdio: 'inherit', windowsHide: true });
  build.on('error', reject);
  build.on('exit', code => code === 0 ? resolve() : reject(new Error(`Performance fixture build exited ${code}`)));
});
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><style>html,body{margin:0;overflow:hidden}canvas{width:997px;height:731px;display:block}</style><canvas id="renderCanvas"></canvas><script src="/fixture.js"></script>');
  } else {
    try {
      response.setHeader('Content-Type', extname(pathname) === '.js' ? 'text/javascript' : extname(pathname) === '.wasm' ? 'application/wasm' : 'image/png');
      response.end(readFileSync(join(output, pathname.slice(1))));
    } catch { response.writeHead(404); response.end(); }
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profileDirectory = mkdtempSync(join(tmpdir(), 'earth-walk-browser-'));
let port;
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--remote-debugging-port=0', `--user-data-dir=${profileDirectory}`,
  '--headless=new', '--window-size=1100,850', '--no-first-run',
  '--disable-extensions', '--disable-default-apps',
  ...(heapMegabytes ? [`--js-flags=--max-old-space-size=${heapMegabytes}`] : []),
  ...(process.argv.includes('--no-direct-composition') ? ['--disable-direct-composition'] : []),
  ...(process.argv.includes('--trace-gpu') ? ['--enable-gpu-service-tracing'] : []),
  ...(process.argv.includes('--uncapped') ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []),
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
const browserLog = join(profileDirectory, 'browser.log');
chrome.stderr.on('data', chunk => appendFileSync(browserLog, chunk));
chrome.on('exit', (code, signal) => appendFileSync(browserLog, `\nBrowser exit: code=${code}, signal=${signal}\n`));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
let send;
let traceStream;
const errors = [];
try {
  let target;
  for (let i = 0; i < 50; i++) {
    try {
      port = Number(readFileSync(join(profileDirectory, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      // Own a new target: Chrome's startup tabs can be replaced during launch.
      target = await (await fetch(`http://localhost:${port}/json/new?about:blank`, {
        method: 'PUT', signal: AbortSignal.timeout(2000),
      })).json();
    } catch {}
    if (target) break;
    await sleep(200);
  }
  if (!target) throw new Error('Browser did not start');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  let rendererCrashed = false;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Tracing.tracingComplete') traceStream = message.params.stream;
    if (message.id) {
      const request = pending.get(message.id); pending.delete(message.id);
      clearTimeout(request?.timer);
      if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Inspector.targetCrashed') {
      rendererCrashed = true;
      console.error('Browser renderer crashed');
      errors.push({ error: 'Browser renderer crashed' });
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Browser renderer crashed')); }
      pending.clear();
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const error = message.params.args.map(a => a.value ?? a.description);
      errors.push(error); console.log('Browser error:', JSON.stringify(error).slice(0,600));
    }
  };
  socket.onclose = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Test browser closed')); }
    pending.clear();
  };
  send = (method, params = {}) => new Promise((resolve, reject) => {
    if (rendererCrashed && method !== 'Browser.close') { reject(new Error('Browser renderer crashed')); return; }
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error('Test browser is not connected')); return; }
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 60000);
    pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await send('Runtime.enable');
  await send('Inspector.enable');
  await send('Page.enable');
  if (osloWalk || vista || memorySoak) await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const navigation = await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/?${osloWalk || vista ? 'oslo-walk' + (process.argv.includes('--metrics') ? '&performance-debug' : '') : snapshotFixture ?? (memorySoak ? 'terrain-size=33' : 'terrain-size=3&detail-size=1&clouds=off')}&seed=1161908820&clock=manual&date=${sceneDate}&time=14&wind-speed=0${process.argv.includes('--no-aa') ? '&no-aa' : ''}` });
  if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
  if (memorySoak) {
    await runMemorySoak({ evaluate, send, output, errors });
  } else if (vista) {
    await runVistaPerformance({ evaluate, send, output, errors });
  } else if (osloWalk) {
    await runOsloWalk({ evaluate, send, output, errors, browserLog, readTrace: async (stop = true) => {
      if (stop) await send('Tracing.end');
      const deadline = Date.now() + 60000;
      while (!traceStream) {
        if (Date.now() > deadline) throw new Error('Browser trace timed out');
        await sleep(100);
      }
      let data = '';
      for (;;) {
        const chunk = await send('IO.read', { handle: traceStream });
        data += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString() : chunk.data;
        if (chunk.eof) break;
      }
      await send('IO.close', { handle: traceStream });
      return data;
    } });
  } else if (pixelTest) {
    for (let i=0;i<120;i++) {
      const state=await evaluate(`({done:window.pixelComplete,error:window.pixelError,results:window.pixelResults})`);
      if(state.error) {
        const screenshot = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(output, 'failure.png'), Buffer.from(screenshot.data, 'base64'));
        throw new Error(state.error);
      }
      if(state.done) {
        console.log('Pixel equivalence:',JSON.stringify(state.results));
        writeFileSync(join(output,'pixels.json'),JSON.stringify(state.results,null,2));
        const screenshots = await evaluate('window.pixelScreenshots ?? {}');
        for (const [name, data] of Object.entries(screenshots)) {
          writeFileSync(join(output,`${name}.png`),Buffer.from(data,'base64'));
        }
        if(errors.length)throw new Error('Browser errors during pixel tests');
        break;
      }
      if(i===119)throw new Error('Pixel tests timed out');
      await sleep(500);
    }
  } else if (snapshot) {
    for (let i = 0; i < 240; i++) {
      const state = await evaluate(`({ready:window.performanceReady,error:window.performanceError,step:window.performanceProgress,builds:window.performanceGame?.activeTileBuilds?.size,tiles:window.performanceGame?.tiles?.size})`);
      if (state.error) throw new Error(state.error);
      if (i % 15 === 0) console.log('Loading', state);
      if (state.ready && state.builds === 0 && state.tiles >= 9) break;
      if (i === 239) throw new Error('World did not settle');
      await sleep(1000);
    }
    await sleep(4000);
    // --eval=<js>: replaces the default camera placement; `g` is the game.
    const placeCamera = process.argv.find(a => a.startsWith('--eval='))?.slice(7)
      ?? 'g.flyCamera.rotation.x=0.08; g.flyCamera.rotation.y=1.2;';
    const evaluated = await evaluate(`(async () => { const g=window.performanceGame; const evalResult = await (async () => { ${placeCamera} })(); g.updateVegetationLod(true); return evalResult === undefined ? null : JSON.stringify(evalResult).slice(0, 6000); })()`);
    if (evaluated) console.log('Eval:', evaluated);
    await sleep(1500);
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, 'snapshot.png'), Buffer.from(screenshot.data, 'base64'));
    console.log('Snapshot saved:', join(output, 'snapshot.png'));
    console.log('Errors:', JSON.stringify(errors).slice(0, 4000));
  } else {
  for (let i = 0; i < 240; i++) {
    const state = await evaluate(`({ready:window.performanceReady,error:window.performanceError,step:window.performanceProgress,builds:window.performanceGame?.activeTileBuilds?.size,tiles:window.performanceGame?.tiles?.size})`);
    if (state.error) throw new Error(state.error);
    if (i % 15 === 0) console.log('Loading', state);
    if (state.ready && state.builds === 0 && state.tiles >= 9) break;
    if (i === 239) throw new Error('World did not settle');
    await sleep(1000);
  }
  await sleep(3000);
  const sceneInfo = await evaluate(`(() => {
    const g=window.performanceGame; g.engine.stopRenderLoop(); g.flyCamera.detachControl();
    g.flyCamera.rotation.x=0.08; g.flyCamera.rotation.y=1.2;
    g.updateVegetationLod(true);
    window.perfInstrumentation = new window.performanceTools.EngineInstrumentation(g.engine);
    window.perfInstrumentation.captureGPUFrameTime=true;
    return {gpu:g.engine.getInfo(),camera:g.flyCamera.position.asArray(),meshes:g.scene.meshes.length};
  })()`);
  console.log('Scene', sceneInfo);
  const results = [];
  const variants = ['shadows-off','pcss-low','pcf-medium','pcf-low','ssr-off','ssr-off-pass','ssr-1x'];
  const phases = [...variants, ...variants.toReversed()].flatMap(v => ['baseline', v]);
  phases.push('baseline');
  for (const variant of phases) {
    const result = await evaluate(`(async () => {
      const g=window.performanceGame, s=g.scene, e=g.engine;
      const shadow=s.lights.find(l=>l.name==='sunLight').getShadowGenerator();
      window.perfPass?.dispose(); window.perfPass=null;
      s.shadowsEnabled=true; shadow.useContactHardeningShadow=true; shadow.filteringQuality=1;
      g.screenSpaceReflections.isEnabled=true; g.screenSpaceReflections.samples=4;
      const variant=${JSON.stringify(variant)};
      if(variant==='shadows-off') s.shadowsEnabled=false;
      if(variant==='pcss-low') shadow.filteringQuality=2;
      if(variant.startsWith('pcf')) {shadow.usePercentageCloserFiltering=true; shadow.filteringQuality=variant==='pcf-low'?2:1;}
      if(variant.startsWith('ssr-off')) g.screenSpaceReflections.isEnabled=false;
      if(variant==='ssr-off-pass') {window.perfPass=new window.performanceTools.PassPostProcess('perf-copy',1,g.flyCamera);window.perfPass.samples=4;}
      if(variant==='ssr-1x') g.screenSpaceReflections.samples=1;
      const frames=[], gpu=[], cpu=[]; let last=null, warmed=0, count=window.perfInstrumentation.gpuFrameTimeCounter.count;
      const start=performance.now();
      await new Promise(resolve=>e.runRenderLoop(function tick(){
        const now=performance.now(); s.render();
        if(now-start>2500 && warmed>=60 && last!==null){ frames.push(now-last);cpu.push(performance.now()-now);
          const q=window.perfInstrumentation.gpuFrameTimeCounter;if(q.count!==count && q.current>0)gpu.push(q.current/1e6);count=q.count;
        }
        warmed++;last=now;if((now-start>6500 && frames.length>=120 && gpu.length>=10) || now-start>30000){e.stopRenderLoop(tick);resolve();}
      }));
      const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
      const gl=e._gl; gl.bindFramebuffer(gl.FRAMEBUFFER,null); const backSamples=gl.getParameter(gl.SAMPLES);
      return {variant,ms:mean(frames),gpu:mean(gpu),gpuN:gpu.length,cpu:mean(cpu),frames:frames.length,sufficientSamples:frames.length>=120 && gpu.length>=10,triangles:s.getActiveIndices()/3,prepass:s.prePassRenderer?.enabled,backSamples,filter:shadow.filter,quality:shadow.filteringQuality};
    })()`);
    results.push(result); console.log(JSON.stringify(result));
    writeFileSync(join(output, 'results.json'), JSON.stringify({sceneInfo,arguments:process.argv.slice(2),results,errors},null,2));
    if (results.length === 1 || results.length === phases.length) {
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(output, `${results.length}-${variant}.png`), Buffer.from(screenshot.data,'base64'));
    }
  }
  console.log('Errors:', JSON.stringify(errors).slice(0,4000));
  }
} finally {
  writeFileSync(join(output, 'errors.json'), JSON.stringify(errors,null,2));
  // Kill the owned Windows tree while its root still exists; closing the root
  // first can leave no parent PID for taskkill to use for the GPU children.
  let stopped = false;
  if (process.platform === 'win32' && chrome.pid && chrome.exitCode === null) {
    const killed = spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', timeout: 10000,
    });
    stopped = killed.status === 0;
  }
  if (!stopped && socket?.readyState === WebSocket.OPEN) {
    await Promise.race([send('Browser.close').catch(() => {}), sleep(2000)]);
  }
  socket?.close();
  if (!stopped) chrome.kill();
  server.closeAllConnections(); server.close();
}
