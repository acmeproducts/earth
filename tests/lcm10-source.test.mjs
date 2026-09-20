import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeLcm10Pixels, fetchLcm10, lcm10ClassToLandCover,
  lcm10TileRequest, LCM10_TILE_SIZE,
} from '../src/world/Lcm10Source.ts';

test('LCM-10 translates all classes without confusing water, buildings and tundra', () => {
  const cases = [[10, 10], [20, 20], [30, 30], [40, 40], [50, 90], [60, 95],
    [70, 100], [80, 60], [90, 50], [100, 80], [110, 70], [254, 0], [255, 0], [0, 0]];
  for (const [source, expected] of cases) assert.equal(lcm10ClassToLandCover(source), expected);
});

test('LCM-10 request windows stay within the correct 3-degree source item worldwide', () => {
  for (const [lat, lon, item] of [
    [59.91, 10.73, 'N57E009'], [60.01, 10.73, 'N60E009'],
    [40.70, -74.01, 'N39W075'], [-33.86, 151.21, 'S36E150'],
    [-0.01, -0.01, 'S03W003'], [0.01, 0.01, 'N00E000'],
    [82.99, 179.99, 'N81E177'], [-59.99, -179.99, 'S60W180'],
  ]) {
    const url = new URL(lcm10TileRequest(Math.floor((84 - lat) / 0.02), Math.floor((lon + 180) / 0.02)));
    assert.ok(url.pathname.includes(`2020_${item}_MAP`), url.pathname);
    const bbox = url.pathname.split('/bbox/')[1].replace('.png', '').split(',').map(Number);
    assert.ok(bbox[0] <= lon && bbox[2] >= lon);
    assert.ok(bbox[1] <= lat && bbox[3] >= lat);
    assert.ok(Math.abs(bbox[2] - bbox[0] - 0.02) < 1e-10);
    assert.equal(url.searchParams.get('resampling'), 'nearest');
    assert.equal(url.searchParams.get('rescale'), '0,255');
  }
});

test('LCM-10 masks transparent, unclassifiable and nodata pixels', () => {
  const rgba = new Uint8ClampedArray(LCM10_TILE_SIZE ** 2 * 4);
  rgba.set([100, 100, 100, 255, 90, 90, 90, 255, 254, 254, 254, 255,
    255, 255, 255, 255, 10, 10, 10, 0]);
  const tile = decodeLcm10Pixels(rgba);
  assert.deepEqual([...tile.pixels[0].slice(0, 5)], [80, 50, 0, 0, 0]);
  assert.deepEqual([...tile.mask.slice(0, 5)], [1, 1, 0, 0, 0]);
  rgba.set([0, 100, 200, 255]);
  assert.throws(() => decodeLcm10Pixels(rgba), /styled imagery/);
  assert.throws(() => decodeLcm10Pixels(new Uint8ClampedArray(4)), /raster size/);
});

test('LCM-10 skips requests outside its geographic coverage', async () => {
  for (const bounds of [
    { lonWest: 10, lonEast: 11, latSouth: 84, latNorth: 85 },
    { lonWest: 10, lonEast: 11, latSouth: -70, latNorth: -65 },
  ]) assert.equal((await fetchLcm10(bounds)).size, 0);
});

test('absent ocean items are cached and never requested from the raster service', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(new URL(url));
    return Response.json({ features: [] });
  });
  const bounds = { lonWest: 35.26, lonEast: 35.28, latSouth: -47.60, latNorth: -47.58 };
  assert.equal((await fetchLcm10(bounds)).size, 0);
  assert.equal((await fetchLcm10({ ...bounds, lonWest: 35.30, lonEast: 35.32 })).size, 0);
  assert.equal(requests.length, 1, 'all windows in one source item share the availability check');
  assert.equal(requests[0].hostname, 'stac.terrascope.be');
  assert.equal(requests[0].searchParams.get('ids'), 'LCFM_LCM-10_V100_2020_S48E033_MAP');
});

test('raster 404 means missing coverage, while server failures still reject and can retry', async (t) => {
  let status = 404;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const request = new URL(url);
    if (request.hostname === 'stac.terrascope.be') {
      return Response.json({ features: [{ id: request.searchParams.get('ids') }] });
    }
    return new Response(null, { status });
  });
  const bounds = { lonWest: -73.01, lonEast: -73.009, latSouth: 40.701, latNorth: 40.702 };
  assert.equal((await fetchLcm10(bounds)).size, 0);
  status = 503;
  const otherBounds = { ...bounds, lonWest: -72.97, lonEast: -72.969 };
  await assert.rejects(fetchLcm10(otherBounds), /tile request failed \(503\)/);
  status = 404;
  assert.equal((await fetchLcm10(otherBounds)).size, 0);
});

test('catalogue failures are not cached as absent land coverage', async (t) => {
  let status = 503;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return status === 200 ? Response.json({ features: [] }) : new Response(null, { status });
  });
  const bounds = { lonWest: 151.211, lonEast: 151.212, latSouth: -33.861, latNorth: -33.860 };
  await assert.rejects(fetchLcm10(bounds), /catalogue request failed \(503\)/);
  status = 200;
  assert.equal((await fetchLcm10(bounds)).size, 0);
  assert.equal(requests, 2);
});
