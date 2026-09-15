import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fpsCounter = readFileSync(new URL("../src/diagnostics/FpsCounter.ts", import.meta.url), "utf8");

test("expanded performance diagnostics split CPU render phases from GPU time", () => {
  assert.match(fpsCounter, /captureActiveMeshesEvaluationTime = enabled/);
  assert.match(fpsCounter, /captureRenderTargetsRenderTime = enabled/);
  assert.match(fpsCounter, /captureRenderTime = enabled/);
  assert.match(fpsCounter, /gpuCounter\?\.lastSecAverage \?\? 0/);
  assert.match(fpsCounter, /render CPU: active/);
  assert.match(fpsCounter, /render GPU:/);
});

test("expensive render instrumentation is disabled with the compact counter", () => {
  const appearance = fpsCounter.slice(
    fpsCounter.indexOf("private updateAppearance"),
    fpsCounter.indexOf("private setDetailedInstrumentation"),
  );
  assert.match(appearance, /this\.setDetailedInstrumentation\(true\)/);
  assert.match(appearance, /this\.setDetailedInstrumentation\(false\)/);
});

test("render stats can be dumped from the debug keyboard controls", () => {
  const game = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
  assert.match(game, /key === "r"/);
  assert.match(game, /dumpRenderStats\(this\.engine, this\.scene, this\.getRenderStatsContext\(\)\)/);
  assert.match(fpsCounter, /earth-render-stats-\$\{timestamp\}\.json/);
  assert.match(fpsCounter, /recentFrames:/);
  assert.match(fpsCounter, /activeMeshes: meshDetails/);
  assert.match(fpsCounter, /capabilities: primitiveProperties\(caps\)/);
});

test("comparative benchmark measures feature ablations only after streaming settles", () => {
  const game = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
  assert.match(game, /key === "b"/);
  assert.match(game, /startComparativeBenchmark/);
  assert.match(game, /reflections-off/);
  assert.match(game, /all-vegetation-impostors/);
  assert.match(fpsCounter, /sample\.activeTileBuilds > 0/);
  assert.match(fpsCounter, /comparativeBenchmark:/);
  assert.match(fpsCounter, /gpuFrameMilliseconds/);
});

test("render report groups mesh workloads and describes render targets", () => {
  assert.match(fpsCounter, /meshWorkloads/);
  assert.match(fpsCounter, /groupMeshWorkloads/);
  assert.match(fpsCounter, /renderTargets/);
  assert.match(fpsCounter, /renderListMeshes/);
});

test("benchmark isolates shadows and reflections and restores shadows between phases", () => {
  const game = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
  const benchmark = game.slice(game.indexOf("private startRenderBenchmark"),
    game.indexOf("private setVegetationMode"));
  assert.match(benchmark, /name: "shadows-off"/);
  assert.match(benchmark, /name: "shadows-off-and-reflections-off"/);
  assert.match(benchmark, /this\.scene\.shadowsEnabled = false/);
  assert.match(benchmark, /this\.scene\.shadowsEnabled = originalShadowsEnabled/);
  assert.match(benchmark, /restore\(\); phase\.apply\(\)/);
  assert.match(benchmark, /\[variants, \[\.\.\.variants\]\.reverse\(\)\]/);
  assert.match(benchmark, /shadowMapPassesIncludingWarmup/);
  assert.match(benchmark, /onBeforeBindObservable\.add/);
  assert.match(benchmark, /onBeforeBindObservable\.remove/);
  assert.match(benchmark, /activePostProcesses:/);
  assert.match(benchmark, /prePassEnabled:/);
});

test("custom shadow receivers honor scene and light shadow switches", () => {
  const receiver = readFileSync(new URL("../src/vegetation/VegetationShadowReceiver.ts", import.meta.url), "utf8");
  assert.match(receiver, /!scene\.shadowsEnabled/);
  assert.match(receiver, /!sun\.shadowEnabled/);
  assert.match(receiver, /vegetationShadowEnabled < 0\.5\) return 1\.0/);
});

test("frame pacing catches stutters outside the measured render callback", () => {
  assert.match(fpsCounter, /frameIntervalMilliseconds/);
  assert.match(fpsCounter, /unattributedMilliseconds/);
  assert.match(fpsCounter, /frameBudgetMilliseconds/);
  assert.match(fpsCounter, /stutterSamples:/);
  assert.match(fpsCounter, /window\.addEventListener\("blur", this\.resetFrameCadence\)/);
});
