import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const renderer = readFileSync(new URL("../src/Renderer.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const fpsCounter = readFileSync(new URL("../src/FpsCounter.ts", import.meta.url), "utf8");
const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");
const captureMaterial = readFileSync(
  new URL("../src/procedural/ProceduralCaptureMaterial.ts", import.meta.url),
  "utf8",
);
const shadowReceiver = readFileSync(
  new URL("../src/VegetationShadowReceiver.ts", import.meta.url),
  "utf8",
);
const water = readFileSync(new URL("../src/Water.ts", import.meta.url), "utf8");
const solarLighting = readFileSync(new URL("../src/SolarLighting.ts", import.meta.url), "utf8");

test("WebGPU is opt-in and falls back to WebGL", () => {
  assert.match(renderer, /query\.get\("renderer"\).*=== "webgpu" \? "webgpu" : "webgl"/);
  assert.match(renderer, /await WebGPUEngine\.IsSupportedAsync/);
  assert.match(renderer, /await webgpu\.initAsync\(\)/);
  assert.match(renderer, /falling back to WebGL/);
  assert.match(renderer, /canvas\.cloneNode\(true\)/);
  assert.match(renderer, /new Engine\(canvas/);
});

test("all scene modes use the shared renderer", () => {
  assert.match(index, /createRenderingEngine\(canvas, backend, engineOptions\)/);
  assert.match(index, /new TreeImpostorValidation\(activeCanvas, engine\)/);
  assert.match(index, /new TreeImpostorDemo\(activeCanvas, engine\)/);
  assert.match(index, /new Game\(activeCanvas, engine\)/);
});

test("render reports distinguish WebGPU from WebGL", () => {
  assert.match(fpsCounter, /backend: engine\.isWebGPU \? "webgpu" : "webgl"/);
  assert.match(fpsCounter, /webGLVersion: backendInfo\.webGLVersion \?\? null/);
  assert.match(fpsCounter, /gpu: backendInfo\.getInfo\?\.\(\) \?\? null/);
});

test("the WebGPU baseline isolates reverse depth and screen-space reflections", () => {
  assert.match(game, /useReverseDepthBuffer = !this\.engine\.isWebGPU \|\| forceReverseDepth/);
  assert.match(game, /!this\.engine\.isWebGPU \|\| forceWebGPUReflections/);
  assert.match(game, /reflectionSetting/);
});

test("optional vegetation samplers always have WebGPU bindings", () => {
  assert.match(captureMaterial, /setTexture\("leafTexture", fallbackTexture\)/);
  assert.match(captureMaterial, /setTexture\("barkTexture", fallbackTexture\)/);
  assert.match(shadowReceiver, /setTexture\("vegetationShadowSampler", fallbackShadowTexture\(scene\)\)/);
});

test("WebGPU does not register Babylon's conventional color attribute twice", () => {
  assert.match(captureMaterial, /attributes: scene\.getEngine\(\)\.isWebGPU/);
  assert.match(
    captureMaterial,
    /\? \["position", "normal", "uv", "vegetationColor", "instanceLodBlend"\]/,
  );
});

test("branch-selected vegetation textures disable WGSL derivative uniformity analysis", () => {
  assert.match(shadowReceiver, /#define DISABLE_UNIFORMITY_ANALYSIS/);
});

test("WebGPU uses native material variants for streamed shadows and water", () => {
  assert.match(
    game,
    /field\.shadowCasterMeshes\.length > 0 \? field\.shadowCasterMeshes : field\.meshes/,
  );
  assert.match(game, /refreshShadowsDuringFade:[\s\S]*?!this\.engine\.isWebGPU/);
  assert.match(
    solarLighting,
    /new ShadowGenerator\([\s\S]*?!scene\.getEngine\(\)\.isWebGPU/,
  );
  assert.match(solarLighting, /if \(!scene\.getEngine\(\)\.isWebGPU\) \{/);
  assert.match(water, /scene\.getEngine\(\)\.isWebGPU\s+\? new StandardMaterial/);
});
