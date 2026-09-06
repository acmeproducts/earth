import test from 'node:test';
import assert from 'node:assert/strict';
import { LoadingActors } from '../src/LoadingActors.ts';
import { publishGeneratedAsset } from '../src/GeneratedAssetPreview.ts';

test('loading preview uses generated atlas pixels and unsubscribes on disposal', () => {
  const draws = [];
  const context = { clearRect() {}, drawImage(...args) { draws.push(args); } };
  const canvas = {
    width: 460, height: 460,
    getContext(kind) { assert.equal(kind, '2d'); return context; },
    setAttribute() {},
  };
  const caption = { textContent: '' };
  const preview = new LoadingActors(canvas, caption);
  assert.equal(draws.length, 0, 'nothing is generated before the world supplies a capture');
  const atlas = {};
  const asset = { name: 'oakTreeImpostor', canvas: atlas, x: 128, y: 0, width: 64, height: 128 };
  publishGeneratedAsset(asset);
  assert.equal(caption.textContent, 'Oak Tree');
  assert.deepEqual(draws[0].slice(0, 5), [atlas, 128, 0, 64, 128]);
  assert.equal(draws[0][7] / draws[0][8], 0.5, 'capture aspect ratio is preserved');
  publishGeneratedAsset({ ...asset, name: 'fernImpostor' });
  assert.equal(caption.textContent, 'Fern');
  assert.equal(draws.length, 2);
  preview.dispose();
  preview.dispose();
  publishGeneratedAsset(asset);
  assert.equal(draws.length, 2, 'world captures no longer touch a disposed preview');
});
