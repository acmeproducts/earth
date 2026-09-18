import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainNormalEdges } from '../src/terrain/TerrainNormalEdges.ts';

function tile(x, y, size, bias) {
  return {id: {level: 16, x, y}, size,
    pixels: Uint8Array.from({length: size * size * 4}, (_, i) =>
      i % 4 === 3 ? 255 : bias + (Math.floor(i / 4) % size) * 3 + Math.floor(i / 4 / size) * 2)};
}
const at = (tile, x, y, channel = 0) => tile.pixels[(y * tile.size + x) * 4 + channel];
const add = (edges, tile) => edges.add(tile.id, tile.size, tile.size, tile.pixels, () => {});

test('neighboring normal maps share interpolated shading across different LODs', () => {
  const edges = new TerrainNormalEdges();
  const west = tile(10, 10, 9, 60), east = tile(11, 10, 5, 120);
  add(edges, west); add(edges, east);
  for (let row = 0; row < 9; row++) for (let channel = 0; channel < 4; channel++) {
    const t = row / 2, lower = Math.floor(t), upper = Math.ceil(t);
    const expected = (at(east, 0, lower, channel) + at(east, 0, upper, channel)) / 2;
    assert.ok(Math.abs(at(west, 8, row, channel) - expected) <= 1);
  }
});

test('four-tile corners are independent of streaming order and old LOD disposal', () => {
  const run = order => {
    const edges = new TerrainNormalEdges();
    const tiles = [tile(10, 10, 9, 20), tile(11, 10, 5, 60), tile(10, 11, 5, 100), tile(11, 11, 9, 140)];
    for (const i of order) add(edges, tiles[i]);
    const corners = [at(tiles[0], 8, 8), at(tiles[1], 0, 4), at(tiles[2], 4, 0), at(tiles[3], 0, 0)];
    assert.ok(corners.every(value => value === corners[0]));
    return tiles.map(tile => tile.pixels);
  };
  assert.deepEqual(run([0, 1, 2, 3]), run([3, 2, 1, 0]));
  const edges = new TerrainNormalEdges();
  const old = tile(10, 10, 5, 10), replacement = tile(10, 10, 9, 80);
  const removeOld = add(edges, old);
  add(edges, replacement); removeOld();
  const east = tile(11, 10, 9, 110); add(edges, east);
  assert.equal(at(replacement, 8, 4), at(east, 0, 4));
});
