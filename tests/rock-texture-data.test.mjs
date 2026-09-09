import assert from "node:assert/strict";
import test from "node:test";

const { getRockTextureData, ROCK_TEXTURE_SIZE } =
  await import("../src/RockTextureData.ts");

const data = getRockTextureData();

function decodeNormal(bytes, index) {
  return [
    bytes[index] / 127.5 - 1,
    bytes[index + 1] / 127.5 - 1,
    bytes[index + 2] / 255,
  ];
}

test("relief normals all point out of the surface and average to straight up", () => {
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < data.normal.length; index += 4) {
    const [x, y, z] = decodeNormal(data.normal, index);
    assert.ok(z > 0.3, `texel ${index / 4} leans too far (z=${z.toFixed(2)})`);
    const length = Math.hypot(x, y, z);
    assert.ok(Math.abs(length - 1) < 0.03, `texel ${index / 4} has length ${length}`);
    assert.equal(data.normal[index + 3], 255);
    sumX += x;
    sumY += y;
  }
  const texels = data.normal.length / 4;
  assert.ok(Math.abs(sumX / texels) < 0.02, `mean x lean ${sumX / texels}`);
  assert.ok(Math.abs(sumY / texels) < 0.02, `mean y lean ${sumY / texels}`);
});

test("detail map follows Babylon's channel convention with a neutral mean", () => {
  let redSum = 0;
  let xSum = 0;
  let ySum = 0;
  for (let index = 0; index < data.detail.length; index += 4) {
    redSum += data.detail[index];
    assert.equal(data.detail[index + 2], 255);
    // Alpha carries x and green carries y; both must decode to real slopes.
    const x = data.detail[index + 3] / 127.5 - 1;
    const y = data.detail[index + 1] / 127.5 - 1;
    assert.ok(Math.hypot(x, y) < 0.96, `texel ${index / 4} is nearly flat-on`);
    xSum += x;
    ySum += y;
  }
  const texels = data.detail.length / 4;
  assert.ok(Math.abs(redSum / texels - 128) < 1.5, `mean red ${redSum / texels}`);
  assert.ok(Math.abs(xSum / texels) < 0.02, `mean x lean ${xSum / texels}`);
  assert.ok(Math.abs(ySum / texels) < 0.02, `mean y lean ${ySum / texels}`);
});

test("carries visible relief rather than a flat map", () => {
  let steep = 0;
  for (let index = 0; index < data.normal.length; index += 4) {
    if (decodeNormal(data.normal, index)[2] < 0.9) steep++;
  }
  assert.ok(steep > data.normal.length / 4 * 0.2, `only ${steep} texels carry slope`);
});

test("caches one shared copy at the production size", () => {
  assert.equal(data.size, ROCK_TEXTURE_SIZE);
  assert.equal(data.normal.length, ROCK_TEXTURE_SIZE * ROCK_TEXTURE_SIZE * 4);
  assert.equal(getRockTextureData(), data);
});
