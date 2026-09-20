// CPU-side renderer benchmark. NullEngine does not measure GPU uploads/shaders.
// Run: yarn node --import ./tests/register-typescript.mjs scripts/benchmark-building-loading.mjs
import { performance } from "node:perf_hooks";
import { FreeCamera, NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { planBuilding } from "../src/buildings/BuildingPlanner.ts";
import { ProceduralBuildingRenderer } from "../src/procedural/ProceduralBuildingRenderer.ts";
import { BUILDING_INTERIOR_CHECK_INTERVAL_MS } from "../src/procedural/BuildingRendererConstants.ts";
import { advanceInteriorFrame } from "../tests/interior-streaming-helpers.mjs";

const terrain = {
  elevations: new Float32Array([10, 10, 10, 10]), minElevation: 10, maxElevation: 10,
  width: 2, height: 2, bounds: { lonWest: 0, lonEast: 1, latSouth: 0, latNorth: 1 },
};
const options = { meshWidth: 100, meshDepth: 100, metersPerUnit: 1 };
const paced = process.argv.includes("--paced");
const caseName = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
const measuredRuns = Number(process.argv.find((arg) => arg.startsWith("--samples="))?.slice(10) ?? 3);
if (!Number.isInteger(measuredRuns) || measuredRuns < 1 || measuredRuns > 10) throw new Error("--samples must be 1–10");
const cases = [
  { name: "house-12x10-2floors", width: 12, depth: 10, floors: 2, building: "house" },
  { name: "apartments-30x16-4floors", width: 30, depth: 16, floors: 4, building: "apartments" },
  { name: "apartments-60x40-8floors", width: 60, depth: 40, floors: 8, building: "apartments" },
  { name: "warehouse-60x40", width: 60, depth: 40, floors: 1, building: "warehouse" },
];
const summaries = [];
for (const fixture of cases) {
  if (caseName && fixture.name !== caseName) continue;
  const samples = [];
  for (let iteration = 0; iteration <= measuredRuns; iteration++) {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const root = new TransformNode(`benchmark-${fixture.name}`, scene);
    const camera = new FreeCamera("camera", new Vector3(0, 12, 0), scene);
    scene.activeCamera = camera;
    try {
      const dx = fixture.width / 200, dz = fixture.depth / 200;
      const plan = planBuilding({ id: `${fixture.name}/run-${iteration}`, properties: {
        building: fixture.building, levels: fixture.floors,
        render_height: fixture.floors * 3.1,
      }, polygon: { outer: [[0.5-dx, 0.5-dz], [0.5+dx, 0.5-dz],
        [0.5+dx, 0.5+dz], [0.5-dx, 0.5+dz]], holes: [] } });
      // Use a constant seed so all repetitions compile identical geometry.
      plan.detailSeed = 12345;
      const measure = (work) => {
        const start = performance.now();
        const result = work();
        return { result, ms: performance.now() - start };
      };
      const exterior = measure(() => ProceduralBuildingRenderer.createDetailed(scene, plan, terrain, options));
      if (!exterior.result) throw new Error(`Missing exterior: ${fixture.name}`);
      if (exterior.result.metadata.interiorFloorCount !== fixture.floors) {
        throw new Error(`Unexpected floor count: ${fixture.name}`);
      }
      const merge = measure(() => ProceduralBuildingRenderer.merge([exterior.result], "buildings", root));
      // Measure the first usable floor, excluding later furniture and adjacent-floor prefetch.
      const slices = [];
      while (merge.result.metadata.loadedInteriorCount !== 1 && slices.length < 20000) {
        slices.push(measure(() => advanceInteriorFrame(scene)).ms);
        if (paced) await new Promise((resolve) => setTimeout(resolve, 16));
      }
      const interior = { ms: slices.reduce((sum, value) => sum + value, 0) };
      if (merge.result.metadata.loadedInteriorCount !== 1) throw new Error(`Interior did not load: ${fixture.name}`);
      camera.position.x = 1000;
      camera.getViewMatrix(true);
      // Allow throttled residency polling to become due, outside measured work.
      await new Promise((resolve) => setTimeout(resolve, BUILDING_INTERIOR_CHECK_INTERVAL_MS + 10));
      const unload = measure(() => advanceInteriorFrame(scene));
      if (merge.result.metadata.loadedInteriorCount !== 0) throw new Error(`Interior did not unload: ${fixture.name}`);
      const sorted = [...slices].sort((a, b) => a - b);
      const sample = { exteriorMs: exterior.ms, mergeMs: merge.ms, proximityLoadMs: interior.ms,
        frames: slices.length, sliceP95Ms: sorted[Math.floor(sorted.length * 0.95)],
        sliceMaxMs: sorted.at(-1), unloadMs: unload.ms };
      if (iteration > 0) samples.push(sample);
      else console.log(`[Benchmark cold] ${fixture.name} ${JSON.stringify(sample)}`);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  }
  const summary = { name: fixture.name, samples: samples.length };
  for (const key of Object.keys(samples[0])) {
    const values = samples.map((sample) => sample[key]).sort((a, b) => a - b);
    summary[key] = { median: +values[Math.floor(values.length / 2)].toFixed(2), max: +values.at(-1).toFixed(2) };
  }
  summaries.push(summary);
}
if (!summaries.length) throw new Error(`Unknown --case: ${caseName}`);
console.log("[Benchmark summary] " + JSON.stringify({ renderer: "Babylon NullEngine (CPU only)",
  milestone: "first usable floor structure", paced, summaries }, null, 2));
