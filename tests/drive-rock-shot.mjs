// Close-up of a placed boulder to check its shading. Requires yarn dev on port 3000.
// Run: yarn node tests/drive-rock-shot.mjs
import { launchBrowser, sleep } from "./browser-harness.mjs";
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const output = mkdtempSync(join(tmpdir(), 'earth-rock-'));
const snow = process.argv.includes('--snow');
const port = 9351;
let chrome, socket;
try {
  const browser = await launchBrowser([
  `--remote-debugging-port=${port}`, `--user-data-dir=${output}/profile`,
  '--headless=new', '--window-size=1440,900',
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
  await send('Page.navigate', { url: 'http://localhost:3000/?clouds=off&terrain-size=3&detail-size=1' });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    ready = await evaluate(`(() => {
      const key = Object.keys(window).find(k => k.startsWith('webpackChunk'));
      if (!key) return false;
      if (!window.__rockRequire) window[key].push([['rock-probe-' + performance.now()], {}, r => window.__rockRequire = r]);
      const req = window.__rockRequire;
      if (!req) return false;
      const store = Object.values(req.c).find(m => m.exports?.EngineStore)?.exports.EngineStore;
      window.__rockScene = store?.LastCreatedScene;
      const rocks = window.__rockScene?.meshes.filter(m => m.name.startsWith('rock-') && m.thinInstanceCount > 0) ?? [];
      return !document.getElementById('loading') && rocks.length > 0;
    })()`);
    if (ready) break;
    if (i % 15 === 0) console.log('Waiting for rocks', i);
    await sleep(1000);
  }
  if (!ready) throw new Error('No rock meshes loaded');
  console.log(await evaluate(`(() => {
    const scene = window.__rockScene;
    const rocks = scene.meshes.filter(m => m.name.startsWith('rock-') && m.thinInstanceCount > 0);
    const camera = scene.activeCamera;
    // Pick the biggest boulder of each family within a few hundred units of the camera.
    const best = { rounded: undefined, angular: undefined };
    const sizes = [];
    for (const mesh of rocks) {
      const world = mesh.getWorldMatrix();
      const family = Number(mesh.name.split('-')[1]) >= 3 ? 'angular' : 'rounded';
      for (const local of mesh.thinInstanceGetWorldMatrices()) {
        const matrix = local.multiply(world);
        const m = matrix.m;
        const radius = Math.hypot(m[0], m[1], m[2]);
        sizes.push(radius);
        const position = { x: m[12], y: m[13], z: m[14] };
        const distance = Math.hypot(position.x - camera.position.x, position.z - camera.position.z);
        if (distance > 400) continue;
        if (!best[family] || radius > best[family].radius) best[family] = { radius, position, name: mesh.name };
      }
    }
    sizes.sort((a, b) => a - b);
    window.__rockBest = best;
    window.__rockHome = camera.position.clone();
    const material = rocks[0].material;
    return { rockMeshes: rocks.length, instances: sizes.length, best,
      radiusUnits: { median: sizes[sizes.length >> 1], p99: sizes[Math.floor(sizes.length * 0.99)], max: sizes[sizes.length - 1] },
      bump: material.bumpTexture?.name, detail: material.detailMap?.texture?.name,
      textures: material.getActiveTextures().map(t => t.name) };
  })()`));
  // Line up one boulder-sized copy of every bare variant beside the biggest
  // placed rock, sharing its geometry and material, so the shading of all
  // shapes can be judged in one close-up regardless of what the scatter chose.
  console.log(await evaluate(`(() => {
    const scene = window.__rockScene;
    const anchor = window.__rockBest.rounded ?? window.__rockBest.angular;
    if (!anchor) return 'no anchor rock';
    const Vector3 = scene.activeCamera.position.constructor;
    const bare = scene.meshes.filter(m => /^rock-\\d+-(bare|mossy)$/.test(m.name) && m.thinInstanceCount > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    const radius = anchor.radius;
    const spacing = radius * 2.6;
    const center = new Vector3(anchor.position.x, anchor.position.y, anchor.position.z);
    // Vegetation would hide a knee-high line-up and its streaming re-enables
    // meshes every frame, so render the showcase and ground on a private layer.
    const SHOWCASE_LAYER = 0x20000000;
    scene.activeCamera.layerMask = SHOWCASE_LAYER;
    for (const mesh of scene.meshes) {
      if (/^terrain /.test(mesh.name)) mesh.layerMask = SHOWCASE_LAYER;
    }
    const placed = [];
    bare.forEach((mesh, index) => {
      const copy = new (mesh.constructor)(mesh.name + '-showcase', scene);
      mesh.geometry.applyToMesh(copy);
      copy.material = mesh.material;
      if (${snow}) {
        const req = window.__rockRequire;
        const snowModule = Object.keys(req.m).find(key => key.endsWith('/src/rendering/SnowCover.ts'));
        if (!snowModule) throw new Error('SnowCover module not found');
        req(snowModule).setMeshSnowCover(copy, 1, 1);
      }
      copy.useVertexColors = true;
      copy.receiveShadows = true;
      copy.layerMask = SHOWCASE_LAYER;
      copy.position.set(center.x + (index - (bare.length - 1) / 2) * spacing, center.y + radius * 0.35, center.z);
      copy.scaling.set(radius, radius * 0.8, radius);
      copy.rotation.y = index * 0.9;
      placed.push(copy.name);
    });
    window.__rockShowcase = { center, radius, width: spacing * bare.length };
    return placed;
  })()`));
  for (const [label, yaw] of [['front', 0.15], ['side', 1.1]]) {
    await evaluate(`(() => {
      const scene = window.__rockScene;
      const { center, radius, width } = window.__rockShowcase;
      const camera = scene.activeCamera;
      const away = width * 0.6;
      camera.position.set(center.x + Math.sin(${yaw}) * away, center.y + radius * 1.5, center.z + Math.cos(${yaw}) * away);
      camera.setTarget(center);
    })()`);
    await sleep(4000);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, `rock-showcase-${label}.png`), Buffer.from(shot.data, 'base64'));
  }
  console.log(await evaluate(`(() => {
    const scene = window.__rockScene;
    const rocks = scene.meshes.filter(m => m.name.startsWith('rock-') && m.thinInstanceCount > 0);
    return rocks.map(m => ({ name: m.name, ready: m.material.isReady(m), error: m.subMeshes[0]?.effect?.getCompilationError() }));
  })()`));
  console.log('Browser errors:', JSON.stringify(errors));
  console.log('Screenshots:', output);
} finally {
  socket?.close();
  chrome?.kill();
}
