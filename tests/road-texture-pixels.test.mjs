import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {roadTexturePixels, ROAD_TEXTURE_SIZE} from '../src/world/RoadTexturePixels.ts';

test('cached road pixels preserve every existing surface byte for byte', () => {
  // Digests captured from the original, uncached generator.
  const expected = {
    marked: '35301888119fce779198ba84e887e244c9370f68c614c8a8a22ca986f8da36bd',
    paved: '9a9234e5d149fb679a4347fdfdf7343f0dd37b1a26f829a8098aefbb09a64a32',
    pedestrian: '32baa655369b30933207f7b3be247a383d94df0ca2b8d9b79bb69a08a8e7fc6a',
    dirt: 'ce50fa0f506809c0d9ba81a9b0fea10d7be970a68ebcbb1fb39f0579bf171cf1',
    unpaved: '10fd03fe62d38258a6c0d7d37ef8d2bfc2297106d1ae4e04c7d7ebe92682c05e',
    ford: '2384144c4670490ccb72295762cc9c408ecc9933e11639c44a7422be29c80d16',
    pavedShoulder: '3398fbad04d0017791673c7203442c6790ee92ada3362be83d707b49fd241ca3',
    unpavedShoulder: '10fd03fe62d38258a6c0d7d37ef8d2bfc2297106d1ae4e04c7d7ebe92682c05e',
    bridgeDeck: '64522210800fee91ee737572a656fdefde74f32c3a2e1e1b1861c09cfacb4f5c',
  };
  for (const [style, hash] of Object.entries(expected)) {
    const pixels = roadTexturePixels(style);
    assert.equal(pixels.length, ROAD_TEXTURE_SIZE * ROAD_TEXTURE_SIZE * 4);
    assert.equal(createHash('sha256').update(pixels).digest('hex'), hash, style);
    assert.equal(roadTexturePixels(style), pixels, 'later tile uploads reuse CPU pixels');
  }
});
