import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/rendering/Impostor.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("Impostor.ts", source, ts.ScriptTarget.Latest, true);
function loadFunction(name, dependencies) {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === name);
  const { outputText } = ts.transpileModule(declaration.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return new Function(...Object.keys(dependencies), `${outputText}; return ${name};`)(...Object.values(dependencies));
}

test("transparent atlas colors respect the radius, preserve alpha, and never cross tile boundaries", async () => {
  const dilate = loadFunction("dilateTransparentTileEdgeColors", {
    atlasRows: loadFunction("atlasRows", {}),
    captureWorkSlice: () => ({}),
    yieldCaptureWorkIfNeeded: async () => {},
  });
  for (const [radius, expected] of [
    [0, [80, 0, 0, 0, 0, 20]],
    [1, [80, 80, 0, 0, 20, 20]],
    [Infinity, [80, 80, 80, 20, 20, 20]],
  ]) {
    const image = { width: 6, height: 1, data: new Uint8ClampedArray([
      80, 30, 10, 128, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 20, 60, 90, 255,
    ]) };
    await dilate(image, 2, 1, 3, 1, radius, true);
    assert.deepEqual(Array.from(image.data).filter((_, i) => i % 4 === 0), expected);
    assert.deepEqual(Array.from(image.data).filter((_, i) => i % 4 === 3), [128, 0, 0, 0, 0, 255]);
    if (radius === Infinity) {
      assert.deepEqual(Array.from(image.data.slice(8, 12)), [80, 30, 10, 0]);
      assert.deepEqual(Array.from(image.data.slice(12, 16)), [20, 60, 90, 0]);
    }
  }
});

test("extreme-distance downsampling keeps fractional coverage and isolates each frame", async () => {
  const pixels = { width: 4, height: 1, data: new Uint8ClampedArray([
    20, 100, 40, 16, 30, 110, 50, 128, 40, 120, 60, 0, 50, 130, 70, 255,
  ]) };
  const draws = [];
  let dilated = false;
  const downsample = loadFunction("downsampleAtlasTiles", {
    document: { createElement: () => ({ getContext: () => ({
      drawImage: (...args) => draws.push(args.slice(1)), getImageData: () => pixels,
    }) }) },
    dilateTransparentTileColors: async () => { dilated = true; },
  });
  const image = await downsample({}, 2, 1, 20, 10, 2, 1, false, true);
  assert.deepEqual(Array.from(image.data).filter((_, i) => i % 4 === 3), [16, 128, 0, 255]);
  assert.deepEqual(draws, [[0, 0, 20, 10, 0, 0, 2, 1], [20, 0, 20, 10, 2, 0, 2, 1]]);
  assert.equal(dilated, true);
});

test("both distant tiers share one texture with separate, correctly aligned rows", async () => {
  const calls = [];
  const create = loadFunction("createImpostorTextures", {
    RawTexture: class {
      constructor(data, width, height) { Object.assign(this, { data, width, height }); }
    },
    Constants: { TEXTUREFORMAT_RGBA: 5 },
    Texture: { BILINEAR_SAMPLINGMODE: 2, CLAMP_ADDRESSMODE: 0 },
    dilateTransparentTileEdgeColors: async () => {},
    downsampleAtlasTiles: async (...args) => {
      const [, columns, rows, , , tileWidth, tileHeight, , preserveCoverage] = args;
      calls.push(preserveCoverage === true);
      return {
        width: columns * tileWidth, height: rows * tileHeight,
        data: new Uint8ClampedArray(columns * rows * tileWidth * tileHeight * 4).fill(preserveCoverage ? 64 : 255),
      };
    },
  });
  const assets = await create({}, "test", [{ getContext: () => ({
    getImageData: () => ({ data: new Uint8ClampedArray(64) }),
  }) }], {
    gridWidth: 2, gridHeight: 2, resolutionWidth: 2, resolutionHeight: 2,
    lowResolutionWidth: 2, lowResolutionHeight: 2,
    ultraLowResolutionWidth: 1, ultraLowResolutionHeight: 1,
  }, false);
  assert.deepEqual(calls, [false, true]);
  assert.equal(assets.lowResolutionTextures.length, 1);
  const packed = assets.lowResolutionTextures[0];
  assert.deepEqual([packed.width, packed.height], [4, 6]);
  assert.ok(packed.data.slice(0, 64).every(value => value === 255));
  for (let row = 4; row < 6; row++) {
    assert.ok(packed.data.slice(row * 16, row * 16 + 8).every(value => value === 64));
    assert.ok(packed.data.slice(row * 16 + 8, (row + 1) * 16).every(value => value === 0));
  }
});
