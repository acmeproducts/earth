// Isolated headless Chrome profile: does not connect to the user's browser.
// yarn node tests/drive-render-performance.mjs [--no-aa] [--uncapped]
// yarn node tests/drive-render-performance.mjs --pixels
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import webpack from 'webpack';

const output = mkdtempSync(join(tmpdir(), 'earth-render-perf-'));
const pixelTest = process.argv.includes('--pixels');
console.log('Artifacts:', output);
const compiler = webpack({ mode: 'development', devtool: false,
  entry: new URL(pixelTest ? './fixtures/cloud-shadow-pixels.ts' : './fixtures/performance-scene.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
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
const port = 9359;
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--remote-debugging-port=${port}`, `--user-data-dir=${output}/profile`,
  '--headless=new', '--window-size=1100,850', '--no-first-run',
  ...(process.argv.includes('--uncapped') ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []),
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
], { stdio: 'ignore', windowsHide: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
const errors = [];
try {
  let target;
  for (let i = 0; i < 50; i++) {
    try { target = (await (await fetch(`http://localhost:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
    if (target) break;
    await sleep(200);
  }
  if (!target) throw new Error('Browser did not start');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id); pending.delete(message.id);
      if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const error = message.params.args.map(a => a.value ?? a.description);
      errors.push(error); console.log('Browser error:', JSON.stringify(error).slice(0,600));
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/?terrain-size=3&detail-size=1&clouds=off&seed=1161908820&clock=manual&date=2026-09-05&time=14&wind-speed=0${process.argv.includes('--no-aa') ? '&no-aa' : ''}` });
  if (pixelTest) {
    for (let i=0;i<120;i++) {
      const state=await evaluate(`({done:window.pixelComplete,error:window.pixelError,results:window.pixelResults})`);
      if(state.error)throw new Error(state.error);
      if(state.done) {
        console.log('Pixel equivalence:',JSON.stringify(state.results));
        writeFileSync(join(output,'pixels.json'),JSON.stringify(state.results,null,2));
        if(errors.length)throw new Error('Browser errors during pixel tests');
        break;
      }
      if(i===119)throw new Error('Pixel tests timed out');
      await sleep(500);
    }
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
  socket?.close(); chrome.kill(); server.close();
}
