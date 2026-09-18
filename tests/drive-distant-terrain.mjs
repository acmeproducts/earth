import { chromium } from '../.cache/sand-validation/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

const output = '.cache/distant-terrain';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://localhost:3000/?terrain-size=5&detail-size=1&date=2026-06-21&time=12');
  await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden'), undefined, { timeout: 180000 });
  await page.evaluate(() => {
    const chunkKey = Object.keys(window).find(key => key.startsWith('webpackChunk'));
    window[chunkKey].push([['distance-probe'], {}, req => {
      window.__distanceScene = Object.values(req.c).map(module => module.exports)
        .find(exports => exports?.EngineStore)?.EngineStore.LastCreatedScene;
    }]);
    const camera = window.__distanceScene.activeCamera;
    const ground = window.__distanceScene.meshes.find(mesh => mesh.name.startsWith('terrain ') && !mesh.name.endsWith('skirt'));
    const box = ground.getBoundingInfo().boundingBox;
    const width = box.maximumWorld.x - box.minimumWorld.x;
    camera.position.set(box.centerWorld.x, box.maximumWorld.y + width * 0.3, box.minimumWorld.z - width * 0.5);
    camera.rotation.x = 0.3;
    camera.rotation.y = 0;
  });
  await page.waitForTimeout(15000);
  for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${output}/${label}.png` });
    console.log(label, await page.evaluate(() => new Promise(resolve => window.__distanceScene.onAfterRenderObservable.addOnce(() => {
      const canvas = document.querySelector('#renderCanvas');
      const sample = document.createElement('canvas'); sample.width = 32; sample.height = 32;
      const ctx = sample.getContext('2d'); ctx.drawImage(canvas, 0, 0, 32, 32);
      const pixels = ctx.getImageData(0, 0, 32, 32).data;
      resolve({ colors: new Set(Array.from({length: 1024}, (_, i) => pixels.slice(i * 4, i * 4 + 3).join(','))).size,
        terrainMeshes: window.__distanceScene.meshes.filter(mesh => mesh.name.startsWith('terrain ')).length });
    }))));
  }
  console.log('Page errors:', errors);
} finally {
  await browser.close();
}
