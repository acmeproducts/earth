import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// yarn node tests/drive-render-performance.mjs --memory-soak --fixture=terrain-size=33 --seconds=300
export async function runMemorySoak({ evaluate, send, output, errors }) {
  const directory = join('.cache', 'memory-soak', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(directory, { recursive: true });
  console.log('Memory artifacts:', directory);
  const seconds = Number(process.argv.find(arg => arg.startsWith('--seconds='))?.slice(10) ?? 300);
  assert.ok(Number.isFinite(seconds) && seconds >= 60, 'Soak must run for at least 60 seconds');
  const samples = [];
  await send('HeapProfiler.startSampling', { samplingInterval: 65536 });
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    await send('HeapProfiler.collectGarbage');
    const heap = await send('Runtime.getHeapUsage');
    const state = await evaluate(`(() => {
      const g = window.performanceGame;
      if (!g) return { ready: false, error: window.performanceError };
      const tiles = [...g.tiles.values()];
      const textureBytes = {};
      for (const t of g.scene.textures) {
        const name = t.name.includes('Atlas') || t.name.includes('exposure-') ? 'impostors' : t.name.includes('relief normals') ? 'terrain normals' : t.name;
        const bytes = t.getInternalTexture()?._bufferView?.byteLength ?? 0;
        if (bytes) textureBytes[name] = (textureBytes[name] ?? 0) + bytes;
      }
      return { ready: !!window.performanceReady, error: window.performanceError,
        tiles: tiles.length, builds: g.activeTileBuilds.size,
        scenery: tiles.filter(t => t.farTreeField && t.farBuildings && t.farRoads || t.detailed).length,
        meshes: g.scene.meshes.length, geometries: g.scene.geometries.length,
        materials: g.scene.materials.length, textures: g.scene.textures.length,
        observers: g.scene.onBeforeRenderObservable.observers.length,
        textureBytes, position: g.worldLocation.value,
        settings: g.sceneSettings.value };
    })()`);
    const sample = { seconds: (Date.now() - started) / 1000, ...heap, ...state };
    samples.push(sample);
    writeFileSync(join(directory, 'memory-soak.json'), JSON.stringify({ bundle: output, samples, errors }, null, 2));
    console.log('Memory:', JSON.stringify({ seconds: sample.seconds, heapMiB: Math.round(heap.usedSize / 1024 ** 2),
      buffersMiB: Math.round((heap.backingStorageSize ?? 0) / 1024 ** 2), tiles: state.tiles, scenery: state.scenery }));
    if (heap.usedSize + (heap.backingStorageSize ?? 0) >= 1536 * 1024 ** 2 || Date.now() - started > (seconds - 6) * 1000) {
      const profile = await send('HeapProfiler.getSamplingProfile');
      writeFileSync(join(directory, 'memory-allocations.json'), JSON.stringify(profile));
    }
    assert.ok(!state.error, state.error);
    assert.ok(heap.usedSize + (heap.backingStorageSize ?? 0) < 1536 * 1024 ** 2, 'Retained memory exceeded 1.5 GiB');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(directory, 'scene.png'), Buffer.from(screenshot.data, 'base64'));
  assert.ok(samples.at(-1).ready, 'World did not initialize');
  assert.equal(errors.length, 0, 'Browser errors during memory soak');
  const settled = samples.filter(s => s.ready && s.builds === 0 && s.scenery === s.tiles);
  assert.ok(settled.length >= 3, 'World must finish streaming before checking memory stability');
  const first = settled[0], last = settled.at(-1);
  assert.ok(last.seconds - first.seconds >= 30, 'Need at least 30 seconds of settled observation');
  assert.ok(last.usedSize + last.backingStorageSize - first.usedSize - first.backingStorageSize < 32 * 1024 ** 2,
    'Settled heap and buffers grew by more than 32 MiB');
  assert.ok(last.meshes <= first.meshes + 10, 'Settled scene keeps accumulating meshes');
  console.log('Memory soak passed:', directory);
}
