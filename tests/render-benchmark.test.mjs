import assert from "node:assert/strict";
import test from "node:test";
import { FpsCounter, summarizeBenchmarkPhase, addBenchmarkDeltas } from "../src/diagnostics/FpsCounter.ts";

const sample = (interval, gpu = 0) => ({
  frameIntervalMilliseconds: interval, gpuFrameMilliseconds: gpu,
  gameMilliseconds: 2, renderMilliseconds: 3, drawCalls: 90, activeTriangles: 1000,
});

test("each repeat compares against its own preceding baseline", () => {
  const results = addBenchmarkDeltas([
    summarizeBenchmarkPhase("baseline", [sample(40)]),
    summarizeBenchmarkPhase("variant", [sample(20)]),
    summarizeBenchmarkPhase("baseline", [sample(20)]),
    summarizeBenchmarkPhase("variant", [sample(20)]),
  ]);
  assert.equal(results[1].relativeToBaseline.averageFpsPercent, 100);
  assert.equal(results[3].relativeToBaseline.averageFpsPercent, 0);
  assert.equal(results[3].baselinePhaseIndex, 2);
});

test("benchmark FPS measures throughput and GPU statistics omit missing queries", () => {
  const result = summarizeBenchmarkPhase("baseline", [sample(10, 8), sample(30), sample(20, 12)]);
  assert.equal(result.fps.average, 50);
  assert.equal(result.gpuSamples, 2);
  assert.equal(result.gpuFrame.average, 10);
  assert.equal(summarizeBenchmarkPhase("no-timers", [sample(20)]).gpuFrame, null);
});

test("benchmark only records fresh GPU results and restarts after streaming", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { hidden: false };
  try {
    const counter = Object.create(FpsCounter.prototype);
    const gpu = { count: 7, current: 12_000_000 };
    counter.engineInstrumentation = { gpuFrameTimeCounter: gpu };
    counter.instrumentation = { drawCallsCounter: { current: 90 } };
    counter.benchmark = {
      warmupFrames: 0, warmupMilliseconds: 1500, lastGpuSampleCount: 7,
      samples: [], phases: [{ name: "baseline" }], phaseIndex: 0,
    };
    const cpu = { gameMilliseconds: 2, renderMilliseconds: 3, activeTileBuilds: 0 };
    const scene = { getActiveIndices: () => 3000 };
    counter.recordBenchmarkSample(cpu, 20, scene);
    gpu.count++;
    counter.recordBenchmarkSample(cpu, 20, scene);
    counter.recordBenchmarkSample(cpu, 20, scene);
    assert.deepEqual(counter.benchmark.samples.map(s => s.gpuFrameMilliseconds), [0, 12, 0]);
    counter.recordBenchmarkSample({ ...cpu, activeTileBuilds: 1 }, 20, scene);
    assert.equal(counter.benchmark.samples.length, 0);
    assert.equal(counter.benchmark.warmupMilliseconds, 0);
    assert.equal(counter.benchmark.warmupFrames, 60);
    for (let i = 0; i < 60; i++) counter.recordBenchmarkSample(cpu, 10, scene);
    assert.equal(counter.benchmark.samples.length, 0, "frame count alone must not finish warmup");
    globalThis.document.hidden = true;
    counter.recordBenchmarkSample(cpu, 5000, scene);
    assert.equal(counter.benchmark.warmupMilliseconds, 0);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
