// Install the isolated diagnostic dependency with:
// npm install --prefix .cache/sand-validation --no-audit --no-fund playwright
import { chromium } from '../.cache/sand-validation/node_modules/playwright/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const output = '.cache/sand-validation';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(message.text().slice(0, 300));
  });
  await page.goto(`http://localhost:3003/?terrain-size=5&detail-size=1&date=2026-06-21&time=${process.env.SAND_TIME ?? 9}`);
  await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden'), undefined, { timeout: 180000 });
  await page.keyboard.press('Escape');
  await page.getByRole('spinbutton', {name: 'Latitude', exact: true}).fill('31.1588');
  await page.getByRole('spinbutton', {name: 'Longitude', exact: true}).fill('-3.9859');
  await page.getByRole('button', {name: 'Go', exact: true}).last().click();
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden'), undefined, { timeout: 180000 });
  await page.evaluate(() => {
    const chunkKey = Object.keys(window).find(key => key.startsWith('webpackChunk'));
    window[chunkKey].push([['sand-probe'], {}, req => { window.__sandRequire = req; }]);
    const modules = Object.values(window.__sandRequire.c).map(module => module.exports);
    window.__sandScene = modules.find(exports => exports?.EngineStore)?.EngineStore.LastCreatedScene;
  });
  const mappedCover = await page.evaluate(async () => {
    const modules = Object.values(window.__sandRequire.c).map(module => module.exports);
    const osm = modules.find(exports => exports?.OpenStreetMap)?.OpenStreetMap;
    const bounds = {lonWest: -3.9869, lonEast: -3.9849, latSouth: 31.1578, latNorth: 31.1598};
    const tiles = await osm.fetch(bounds);
    return osm.createLandCoverSampler(tiles, {sample: () => 60}).sample(-3.9859, 31.1588);
  });
  console.log('Mapped land cover:', mappedCover);
  await page.waitForTimeout(10000);
  await page.locator('#renderCanvas').focus();
  await page.keyboard.press('g');
  const beforeMove = await page.evaluate(() => window.__sandScene.activeCamera.position.asArray());
  await page.keyboard.down('w');
  await page.waitForTimeout(600);
  await page.keyboard.up('w');
  await page.evaluate(() => {
    const camera = window.__sandScene.activeCamera;
    camera.rotation.x = 0.2;
    camera.rotation.y = 0.8;
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${output}/dunes-desktop.png` });
  const metrics = await page.evaluate(async () => {
    const scene = window.__sandScene;
    const meshes = scene.meshes.filter(mesh => mesh.name.startsWith('terrain ') && !mesh.name.endsWith('skirt'));
    const canvas = document.querySelector('canvas');
    const sample = document.createElement('canvas'); sample.width = 32; sample.height = 32;
    const ctx = sample.getContext('2d');
    await new Promise(resolve => scene.onAfterRenderObservable.addOnce(() => {
      ctx.drawImage(canvas, 0, 0, 32, 32); resolve();
    }));
    const pixels = ctx.getImageData(0, 0, 32, 32).data;
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 4) colors.add(`${pixels[i]},${pixels[i+1]},${pixels[i+2]}`);
    return { terrainMeshes: meshes.length, colors: colors.size,
      camera: scene.activeCamera.position.asArray(),
      ready: meshes.every(mesh => mesh.isReady(true)) };
  });
  await page.keyboard.press('g');
  await page.evaluate(() => {
    const scene = window.__sandScene, camera = scene.activeCamera;
    window.__sandGroundPose = { position: camera.position.clone(), rotation: camera.rotation.clone() };
    const tile = scene.meshes.find(mesh => mesh.name.startsWith('terrain ') && mesh.metadata?.metersPerUnit);
    camera.position.y += 100 / tile.metadata.metersPerUnit;
    camera.rotation.x = 0.75;
  });
  await page.waitForTimeout(1500);
  const withSkirts = await page.screenshot({path: `${output}/dunes-aerial.png`});
  await page.evaluate(() => {
    for (const mesh of window.__sandScene.meshes) if (mesh.name.startsWith('terrain ') && mesh.name.endsWith('skirt')) mesh.setEnabled(false);
  });
  await page.waitForTimeout(300);
  const withoutSkirts = await page.screenshot({path: `${output}/dunes-aerial-no-skirts.png`});
  const skirtDifference = await page.evaluate(async ({first, second}) => {
    const read = async data => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };
    const a = await read(first), b = await read(second);
    let changed = 0, total = 0;
    for (let y = 80; y < a.height - 80; y++) for (let x = 80; x < a.width - 80; x++) {
      const i = (y * a.width + x) * 4;
      if (Math.max(...[0, 1, 2].map(c => Math.abs(a.data[i+c] - b.data[i+c]))) > 12) changed++;
      total++;
    }
    return {changed, total, fraction: changed / total};
  }, {first: withSkirts.toString('base64'), second: withoutSkirts.toString('base64')});
  await page.evaluate(() => {
    for (const mesh of window.__sandScene.meshes) if (mesh.name.startsWith('terrain ') && mesh.name.endsWith('skirt')) mesh.setEnabled(true);
  });
  await page.evaluate(() => {
    const camera = window.__sandScene.activeCamera;
    camera.position.copyFrom(window.__sandGroundPose.position);
    camera.rotation.copyFrom(window.__sandGroundPose.rotation);
  });
  await page.setViewportSize({width: 390, height: 844});
  await page.waitForTimeout(1500);
  await page.screenshot({path: `${output}/dunes-mobile.png`});
  const moved = metrics.camera.some((value, index) => Math.abs(value - beforeMove[index]) > 0.001);
  const report = { mappedCover, metrics, moved, skirtDifference, errors };
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (![61, 62].includes(mappedCover) || metrics.terrainMeshes === 0 || metrics.colors < 10 || !metrics.ready || !moved || skirtDifference.fraction > 0.001 || errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
