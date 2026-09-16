import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fpsCounter = readFileSync(new URL("../src/diagnostics/FpsCounter.ts", import.meta.url), "utf8");

test("performance view includes persistent slow-operation summaries", () => {
  assert.match(fpsCounter, /const slow = creationStats\.slowOperationsSnapshot\(\)/);
  assert.match(fpsCounter, /Slow operations >/);
  assert.match(fpsCounter, /No slow operations recorded/);
  assert.match(fpsCounter, /operation\.maximumMilliseconds\.toFixed/);
  assert.match(fpsCounter, /operation\.latestMilliseconds\.toFixed/);
});

test("expanded performance diagnostics split CPU render phases from GPU time", () => {
  assert.match(fpsCounter, /captureActiveMeshesEvaluationTime = enabled/);
  assert.match(fpsCounter, /captureRenderTargetsRenderTime = enabled/);
  assert.match(fpsCounter, /captureRenderTime = enabled/);
  assert.match(fpsCounter, /gpuCounter\?\.lastSecAverage \?\? 0/);
  assert.match(fpsCounter, /render CPU: active/);
  assert.match(fpsCounter, /render GPU:/);
});

test("frame history retains aligned render phases only with detailed instrumentation", () => {
  assert.match(fpsCounter, /renderPhases: this\.expanded \? \{/);
  assert.match(fpsCounter, /drawSubmission: this\.instrumentation\.renderTimeCounter\.current/);
  assert.match(fpsCounter, /cameraRender: this\.instrumentation\.cameraRenderTimeCounter\.current/);
  assert.match(fpsCounter, /creationStats\.recordSlowOperation\(`frame\.\$\{phase\}`, milliseconds\)/);
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

test("render report groups mesh workloads and describes render targets", () => {
  assert.match(fpsCounter, /meshWorkloads/);
  assert.match(fpsCounter, /groupMeshWorkloads/);
  assert.match(fpsCounter, /renderTargets/);
  assert.match(fpsCounter, /renderListMeshes/);
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
