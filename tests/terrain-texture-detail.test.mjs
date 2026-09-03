import test from "node:test";
import assert from "node:assert/strict";

const {
  createTerrainTextureData,
  metersPerTexel,
  TERRAIN_ALBEDO_LAYER,
  TERRAIN_DETAIL_LAYER,
  TERRAIN_NORMAL_LAYER,
} = await import("../src/TerrainTextureData.ts");

const LAYERS = [TERRAIN_ALBEDO_LAYER, TERRAIN_NORMAL_LAYER, TERRAIN_DETAIL_LAYER];

/**
 * A camera at eye height sees roughly 2.4mm of ground per screen pixel a few
 * metres ahead. Any layer coarser than that is being magnified rather than
 * resolved, which is what reads as blotchiness.
 */
const SCREEN_PIXEL_GROUND_METERS = 0.0024;

test("resolves ground detail down to the size of a screen pixel underfoot", () => {
  const finest = Math.min(...LAYERS.map(metersPerTexel));
  assert.ok(
    finest <= SCREEN_PIXEL_GROUND_METERS,
    `finest layer resolves ${(finest * 1000).toFixed(1)}mm per texel, which a ` +
    `walking camera magnifies ${(finest / SCREEN_PIXEL_GROUND_METERS).toFixed(1)}x`,
  );
});

test("spaces the layers apart without letting a scale band go uncovered", () => {
  const repeats = LAYERS.map((layer) => layer.metersPerRepeat).sort((a, b) => b - a);
  for (let index = 1; index < repeats.length; index++) {
    const ratio = repeats[index - 1] / repeats[index];
    assert.ok(ratio > 1.2, `layers repeat at ${repeats[index - 1]}m and ${repeats[index]}m, too close to differ`);
    assert.ok(ratio < 10, `a scale band is uncovered between ${repeats[index - 1]}m and ${repeats[index]}m repeats`);
  }
  // Repeats that divide into each other line their seams up into a grid.
  for (let index = 1; index < repeats.length; index++) {
    const ratio = repeats[index - 1] / repeats[index];
    assert.ok(
      Math.abs(ratio - Math.round(ratio)) > 0.05,
      `repeats ${repeats[index - 1]}m and ${repeats[index]}m are harmonic (${ratio.toFixed(2)}x)`,
    );
  }
});

test("fades the detail layer out instead of tinting distant ground", () => {
  const { detail } = createTerrainTextureData();
  const channelMean = (offset) => {
    let sum = 0;
    for (let index = offset; index < detail.length; index += 4) sum += detail[index];
    return sum / (detail.length / 4);
  };

  // Distant mip levels average the whole layer, so its mean is what remains
  // once the grain is too small to resolve. 128 is Babylon's neutral value for
  // both the albedo modulation and the packed normal axes.
  assert.ok(Math.abs(channelMean(0) - 128) < 1.5, `albedo grain mean ${channelMean(0).toFixed(2)} is not neutral`);
  assert.ok(Math.abs(channelMean(3) - 128) < 2.5, `normal x mean ${channelMean(3).toFixed(2)} is not neutral`);
  assert.ok(Math.abs(channelMean(1) - 128) < 2.5, `normal y mean ${channelMean(1).toFixed(2)} is not neutral`);
});

test("puts the base albedo's contrast at feature scale, not across the repeat", () => {
  const { albedo } = createTerrainTextureData();
  const size = TERRAIN_ALBEDO_LAYER.size;
  const luminance = (index) => (albedo[index] + albedo[index + 1] + albedo[index + 2]) / 3;

  // A repeat becomes visible when whole regions differ in average brightness,
  // so the low-frequency content is what has to stay flat.
  const blocks = 4;
  const blockSize = size / blocks;
  const averages = [];
  for (let blockY = 0; blockY < blocks; blockY++) {
    for (let blockX = 0; blockX < blocks; blockX++) {
      let sum = 0;
      for (let y = 0; y < blockSize; y++) {
        for (let x = 0; x < blockSize; x++) {
          sum += luminance(((blockY * blockSize + y) * size + blockX * blockSize + x) * 4);
        }
      }
      averages.push(sum / (blockSize * blockSize));
    }
  }
  const blockSpread = Math.max(...averages) - Math.min(...averages);
  assert.ok(blockSpread < 9, `block brightness spreads ${blockSpread.toFixed(1)}/255, enough to read as tiling`);

  // Contrast at the scale the layer exists to carry — a few centimetres of
  // ground — must clearly exceed that, or the layer is flat grey and the ground
  // has nothing to show between the vertex colors and the detail map.
  const featureOffset = 8;
  let featureContrast = 0;
  let samples = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const here = (y * size + x) * 4;
      const away = (y * size + (x + featureOffset) % size) * 4;
      featureContrast += Math.abs(luminance(here) - luminance(away));
      samples++;
    }
  }
  featureContrast /= samples;
  assert.ok(
    featureContrast > blockSpread,
    `${(featureOffset * metersPerTexel(TERRAIN_ALBEDO_LAYER) * 100).toFixed(0)}cm contrast is ` +
    `${featureContrast.toFixed(2)}/255, below the ${blockSpread.toFixed(2)}/255 spread across the repeat`,
  );
  assert.ok(featureContrast > 5, `${featureContrast.toFixed(2)}/255 of local contrast reads as flat grey`);
});

test("tiles seamlessly across every layer edge", () => {
  const data = createTerrainTextureData();
  const layers = [
    ["albedo", data.albedo, TERRAIN_ALBEDO_LAYER.size],
    ["normal", data.normal, TERRAIN_NORMAL_LAYER.size],
    ["detail", data.detail, TERRAIN_DETAIL_LAYER.size],
  ];

  for (const [name, pixels, size] of layers) {
    // A wrapping texture's opposite edges must be as similar as any interior
    // neighbours, otherwise the repeat shows up as a hard line on the ground.
    let seamDifference = 0;
    let interiorDifference = 0;
    for (let y = 0; y < size; y++) {
      const west = (y * size) * 4;
      const east = (y * size + size - 1) * 4;
      const interior = (y * size + (size >> 1)) * 4;
      for (let channel = 0; channel < 3; channel++) {
        seamDifference += Math.abs(pixels[east + channel] - pixels[west + channel]);
        interiorDifference += Math.abs(pixels[interior + channel] - pixels[interior + 4 + channel]);
      }
    }
    assert.ok(
      seamDifference <= interiorDifference * 3 + size,
      `${name} layer edges differ by ${seamDifference} against ${interiorDifference} inside`,
    );
  }
});
