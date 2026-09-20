import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

// OpenFreeMap tile 17/38598/49289 projected through the application's NYC
// coordinate frame. Rounding meshDepth to 25 hides the original regression.
test('NYC road worker completes without exponential fragment duplication', { timeout: 10000 }, async () => {
  const input = JSON.parse(readFileSync(new URL('./fixtures/nyc-road-planning.json', import.meta.url)));
  const worker = new Worker(new URL('./fixtures/road-planning-worker.mjs', import.meta.url));
  let timer;
  try {
    const response = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('NYC road planning exceeded 5 seconds')), 5000);
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.postMessage({ id: 1, input });
    });
    assert.equal(response.ok, true);
    assert.ok(response.output.plan.roads.length > 100);
    assert.ok(response.output.plan.roads.length < 2000);
    const partition = response.output.timings.find(t => t.stage === 'planner road partitioning');
    assert.ok(partition.durationMilliseconds < 2000);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});
