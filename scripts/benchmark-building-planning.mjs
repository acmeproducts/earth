// yarn node --import ./tests/register-typescript.mjs scripts/benchmark-building-planning.mjs
import { Worker } from "node:worker_threads";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { NullEngine, Scene } from "@babylonjs/core";
import { mergeOverlappingBuildings } from "../src/buildings/CompositeBuildings.ts";
import { planBuilding } from "../src/buildings/BuildingPlanner.ts";
import { worldTileBounds } from "../src/world/WorldGrid.ts";
import { ProceduralBuildingRenderer } from "../src/procedural/ProceduralBuildingRenderer.ts";
import { WorkerTaskClient } from "../src/core/workers/WorkerTaskClient.ts";
import { streamingDiagnosticsSnapshot } from "../src/diagnostics/StreamingDiagnostics.ts";

const worldTile = { level: 17, x: 69445, y: 38124 };
const x = Math.floor(worldTile.x / 8), y = Math.floor(worldTile.y / 8);
const response = await fetch(`https://tiles.openfreemap.org/planet/latest/14/${x}/${y}.pbf`);
if (!response.ok) throw new Error(`Provider returned ${response.status}`);
const tile = new VectorTile(new PbfReader(new Uint8Array(await response.arrayBuffer())));
const layer = tile.layers.building, sources = [];
for (let i = 0; i < layer.length; i++) {
  const feature = layer.feature(i), geometry = feature.toGeoJSON(x, y, 14).geometry;
  if (feature.properties.hide_3d) continue;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates]
    : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  for (const [part, rings] of polygons.entries()) sources.push({
    id: `building/14/${feature.id ?? i}/${part}`,
    polygon: { outer: rings[0], holes: rings.slice(1) }, properties: { ...feature.properties },
  });
}
const composite = mergeOverlappingBuildings(sources);
const source = composite.find((source) => source.id.includes("building/14/16115800/198"));
if (!source) throw new Error("The provider no longer contains the benchmark building");
const bounds = worldTileBounds(worldTile);
const metersPerUnit = 2 * Math.PI * 6378137 / 2 ** 17 *
  Math.cos((bounds.latNorth + bounds.latSouth) / 2 * Math.PI / 180) / 25;
const terrain = { elevations: new Float32Array([10,10,10,10]), width: 2, height: 2,
  minElevation: 10, maxElevation: 10, bounds, worldTile };
const options = { meshWidth: 25, meshDepth: 25, metersPerUnit, renderWholeBuildingFootprints: true,
  neighboringBuildingFootprints: composite.map((source) => source.polygon) };
const client = new WorkerTaskClient(() => {
  const worker = new Worker(new URL("../tests/fixtures/building-planning-worker.mjs", import.meta.url));
  const adapter = { postMessage: (data) => worker.postMessage(data), terminate: () => worker.terminate() };
  worker.on("message", (data) => adapter.onmessage?.({ data }));
  worker.on("error", (error) => adapter.onerror?.({ message: error.message, preventDefault() {} }));
  return adapter;
});
try {
  for (const mode of ["synchronous", "worker"]) {
    const engine = new NullEngine(), scene = new Scene(engine);
    let tasks = 0, workerMilliseconds = 0, ticks = 0, maxTimerGap = 0, lastTick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxTimerGap = Math.max(maxTimerGap, now - lastTick);
      lastTick = now;
      ticks++;
    }, 5);
    const start = performance.now();
    try {
      const plan = planBuilding(source);
      const mesh = mode === "synchronous"
        ? ProceduralBuildingRenderer.createDetailed(scene, plan, terrain, options)
        : await ProceduralBuildingRenderer.createDetailedAsync(scene, plan, terrain, options, {
          plan: async (input) => {
            tasks++;
            const output = await client.run(input);
            workerMilliseconds += output.timings[0].durationMilliseconds;
            return output.result;
          },
        }, () => new Promise((resolve) => setImmediate(resolve)));
      const elapsedMilliseconds = performance.now() - start;
      maxTimerGap = Math.max(maxTimerGap, performance.now() - lastTick);
      const stats = streamingDiagnosticsSnapshot();
      const chunks = [...stats.stages, ...stats.slowOperations].filter((entry) =>
        entry.startTimeMilliseconds >= start && entry.label.endsWith("compile chunk"));
      const worst = chunks.sort((a, b) => b.durationMilliseconds - a.durationMilliseconds)[0];
      console.log(JSON.stringify({ mode, elapsedMilliseconds, tasks, workerMilliseconds, ticks,
        maxTimerGap, maximumCompileChunkMilliseconds: worst?.durationMilliseconds,
        worstStage: worst?.stage, vertices: mesh?.getTotalVertices() }));
    } finally {
      clearInterval(timer);
      scene.dispose();
      engine.dispose();
    }
  }
} finally {
  client.dispose();
}
