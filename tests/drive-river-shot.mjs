import assert from 'node:assert/strict';
import webpack from 'webpack';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, sleep } from './browser-harness.mjs';

const output = mkdtempSync(join(tmpdir(), 'earth-river-'));
const compiler = webpack({ mode: 'development', devtool: false,
  entry: fileURLToPath(new URL('./fixtures/river-scene.ts', import.meta.url)),
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
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/fixture.js' ? readFileSync(join(output, 'fixture.js'))
    : '<!doctype html><body><script src="/fixture.js"></script></body>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await launchBrowser(['--remote-debugging-port=9371', `--user-data-dir=${output}/profile`,
    '--headless=new', '--window-size=1280,800', '--enable-unsafe-swiftshader', '--no-first-run', 'about:blank']);
  const { send, evaluate, socket } = browser;
  const errors = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 40; i++) {
    if (await evaluate('!!window.__river?.mesh.isReady(true)')) break;
    await sleep(500);
  }
  await sleep(2000);
  const offsets = [];
  for (const [name, width, height] of [['desktop', 1280, 800], ['mobile', 390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(1000);
    const metrics = await evaluate(`(async () => {
      const { mesh, engine } = window.__river;
      const pixels = await engine.readPixels(0, 0, engine.getRenderWidth(), engine.getRenderHeight());
      let min = 255, max = 0;
      for (let i = 0; i < pixels.length; i += 4) { min = Math.min(min, pixels[i]); max = Math.max(max, pixels[i]); }
      return { ready: mesh.material.isReady(mesh), error: mesh.subMeshes[0].effect.getCompilationError(),
        range: max - min, offset: mesh.material.bumpTexture.vOffset };
    })()`);
    assert.equal(metrics.ready, true);
    assert.ok(!metrics.error, metrics.error);
    assert.ok(metrics.range > 30, 'Canvas must contain visible scene detail');
    offsets.push(metrics.offset);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
    console.log(name, metrics);
  }
  assert.ok(offsets[1] < offsets[0], 'River current must advance');
  assert.deepEqual(errors, []);
  console.log('Screenshots:', output);
} finally {
  browser?.socket.close(); browser?.chrome.kill();
  server.closeAllConnections(); server.close();
}
