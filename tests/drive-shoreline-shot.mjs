// Browser smoke check and coastal close-up. Requires yarn dev on port 3000.
// Run: yarn node tests/drive-shoreline-shot.mjs [--webgpu]
import { launchBrowser, sleep } from "./browser-harness.mjs";
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const output = mkdtempSync(join(tmpdir(), 'earth-shoreline-'));
const port = process.argv.includes('--webgpu') ? 9348 : 9347;
let server;
if (process.argv.includes('--fixture')) {
  const { default: webpack } = await import('webpack');
  const compiler = webpack({ mode: 'development', devtool: false,
    entry: new URL('./fixtures/shoreline-scene.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
    output: { path: output, filename: 'fixture.js' },
    resolve: { extensions: ['.ts', '.js'] },
    module: { rules: [{ test: /\.ts$/, use: { loader: 'ts-loader', options: {
      transpileOnly: true, compilerOptions: { rootDir: process.cwd() },
    } } }] },
  });
  await new Promise((resolve, reject) => compiler.run((error, stats) => {
    compiler.close(() => {});
    if (error || stats.hasErrors()) reject(error ?? new Error(stats.toString('errors-only')));
    else resolve();
  }));
  server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/fixture.js' ? readFileSync(join(output, 'fixture.js'))
      : '<!doctype html><body><script src="/fixture.js"></script></body>');
  });
  await new Promise(resolve => server.listen(9350, '127.0.0.1', resolve));
}
let chrome, socket;
try {
  const browser = await launchBrowser([
  `--remote-debugging-port=${port}`, `--user-data-dir=${output}/profile`,
  '--headless=new', '--window-size=1440,900', '--enable-unsafe-webgpu',
  '--enable-unsafe-swiftshader', '--no-first-run', 'about:blank',
]);
  ({ chrome, socket } = browser);
  const { send, evaluate } = browser;
  const errors = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: server
    ? `http://127.0.0.1:9350/?${port === 9348 ? 'webgpu&' : ''}${process.argv.includes('--lake') ? 'lake' : ''}`
    : `http://localhost:3000/?clouds=off&terrain-size=3&detail-size=1${port === 9348 ? '&renderer=webgpu' : ''}` });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    ready = await evaluate(`(() => {
      if (window.__shoreScene?.meshes.some(m => m.name.endsWith(' shoreline')) && !document.getElementById('loading')) return true;
      const key = Object.keys(window).find(k => k.startsWith('webpackChunk'));
      if (!key) return false;
      if (!window.__shoreRequire) window[key].push([['shoreline-probe-' + performance.now()], {}, r => window.__shoreRequire = r]);
      const req = window.__shoreRequire;
      if (!req) return false;
      const store = Object.values(req.c).find(m => m.exports?.EngineStore)?.exports.EngineStore;
      window.__shoreScene = store?.LastCreatedScene;
      return !document.getElementById('loading') && !!window.__shoreScene?.meshes.some(m => m.name.endsWith(' shoreline'));
    })()`);
    if (ready) break;
    if (i % 15 === 0) console.log('Waiting for coast', i);
    await sleep(1000);
  }
  if (!ready) throw new Error('No shoreline mesh loaded');
  console.log(await evaluate(`(() => {
    const scene = window.__shoreScene;
    const meshes = scene.meshes.filter(m => m.name.endsWith(' shoreline'));
    const mesh = meshes.find(m => m.getTotalIndices() > 60) ?? meshes[0];
    mesh.computeWorldMatrix(true);
    const p = mesh.getVerticesData('position');
    const shore = mesh.getVerticesData('waterShore');
    const heights = Array.from({length: shore.length / 2}, (_, i) => shore[i * 2]);
    let index = -1;
    let closest = Infinity;
    for (let i = 0; i < heights.length; i++) {
      const distance = p[i * 3] ** 2 + p[i * 3 + 2] ** 2;
      if (Math.abs(heights[i]) < 0.00001 && distance < closest) { index = i; closest = distance; }
    }
    if (index < 0) index = 0;
    const center = mesh.getAbsolutePosition().clone();
    center.x += p[index * 3]; center.y += p[index * 3 + 1]; center.z += p[index * 3 + 2];
    const camera = scene.activeCamera;
    const scale = mesh.material.pluginManager.getPlugin('WaterMotion').metersPerUnit;
    let waterIndex = index; closest = Infinity;
    for (let i = 0; i < heights.length; i++) {
      const distance = (p[i * 3] - p[index * 3]) ** 2 + (p[i * 3 + 2] - p[index * 3 + 2]) ** 2;
      if (heights[i] < -0.05 && distance < closest) { closest = distance; waterIndex = i; }
    }
    const dx = p[waterIndex * 3] - p[index * 3];
    const dz = p[waterIndex * 3 + 2] - p[index * 3 + 2];
    const length = Math.max(0.0001, Math.hypot(dx, dz));
    camera.position.copyFrom(center); camera.position.y += 2.0 / scale;
    camera.position.x += dx / length * 12 / scale;
    camera.position.z += dz / length * 12 / scale;
    camera.setTarget(center);
    const slider = document.querySelector('input[aria-label="Time of day"]');
    if (slider) { slider.value = '13'; slider.dispatchEvent(new Event('input', { bubbles: true })); }
    window.__shoreMeshes = meshes;
    return { backend: scene.getEngine().isWebGPU ? 'webgpu' : 'webgl',
      coastalTiles: meshes.length, triangles: meshes.reduce((n,m) => n + m.getTotalIndices()/3, 0),
      sharedWithBroadWater: (scene.getMeshByName('waterMesh') ?? scene.meshes.find(m => m.name.startsWith('terrainLake-')))?.material === mesh.material,
      textures: mesh.material.getActiveTextures().length };
  })()`));
  await sleep(5000);
  for (let frame = 0; frame < 3; frame++) {
    if (server) await evaluate(`(() => {
      const scene = window.__shoreScene;
      for (const material of scene.materials) {
        const plugin = material.pluginManager?.getPlugin('WaterMotion');
        if (!plugin) continue;
        plugin.bindForSubMesh = buffer => {
          buffer.updateFloat4('waterState', plugin.profile.periodSeconds * ${[0.25, 0.75, 1.0][frame]}, 1, plugin.metersPerUnit, Math.PI * 2 / plugin.profile.periodSeconds);
          buffer.updateFloat4('waterShape', plugin.profile.heaveMeters, plugin.profile.crestMeters, plugin.profile.foamStrength, plugin.profile.troughMeters);
        };
      }
      scene.render();
    })()`);
    await sleep(300);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, `coast-${frame}.png`), Buffer.from(shot.data, 'base64'));
    await sleep(2000);
  }
  console.log(await evaluate(`(() => {
    const meshes = window.__shoreMeshes;
    return meshes.map(m => ({name:m.name, ready:m.material.isReady(m),
      error:m.subMeshes[0]?.effect?.getCompilationError()}));
  })()`));
  console.log('Browser errors:', JSON.stringify(errors));
  console.log(await evaluate(`(() => {
    const scene = window.__shoreScene;
    const meshes = window.__shoreMeshes;
    const measure = enabled => {
      meshes.forEach(m => m.setEnabled(enabled));
      for (let i = 0; i < 8; i++) scene.render();
      const samples = [];
      for (let i = 0; i < 24; i++) { const start = performance.now(); scene.render(); samples.push(performance.now() - start); }
      return samples.sort((a,b) => a-b)[12];
    };
    const off = measure(false); const on = measure(true);
    return { cpuFrameMedianMs: { withoutShoreline: off, withShoreline: on } };
  })()`));
  console.log('Screenshots:', output);
  if (errors.some(error => /shore|shader|compil/i.test(JSON.stringify(error)))) process.exitCode = 1;
} finally {
  socket?.close();
  chrome?.kill();
  server?.closeAllConnections();
  server?.close();
}
