// Capture inputs with benchmark-building-planning.mjs --profile first.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runBuildingPlanning } from "../src/buildings/BuildingPlanningTask.ts";
import { buildingLayoutCache } from "../src/buildings/BuildingLayoutPlanner.ts";
import { apartmentLayoutCache } from "../src/buildings/ApartmentLayoutPlanner.ts";

const inputs = JSON.parse(await readFile(process.argv[2] ?? ".building-planning-inputs.json", "utf8"));
const expected = process.argv[3] ? JSON.parse(await readFile(process.argv[3], "utf8")) : undefined;
const caches = [buildingLayoutCache, apartmentLayoutCache];
const cached = caches.map((cache) => cache.getOrCreate.bind(cache));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const mode of ["uncached", "cold", "warm"]) {
  caches.forEach((cache, i) => {
    cache.getOrCreate = mode === "uncached" ? (_input, create) => create() : cached[i];
  });
  const samples = [];
  for (let repeat = 0; repeat < 5; repeat++) {
    if (mode === "cold") caches.forEach((cache) => cache.clear());
    const before = caches.map((cache) => ({ hits: cache.hits, misses: cache.misses }));
    const start = performance.now();
    const results = inputs.map(runBuildingPlanning);
    const ms = performance.now() - start;
    // Compare to a capture from before the optimization, outside the timed region.
    if (expected) assert.deepEqual(JSON.parse(JSON.stringify(results)), expected);
    samples.push(ms);
    if (repeat === 4) console.log(JSON.stringify({ mode, medianMs: median(samples),
      caches: caches.map((cache, i) => ({ kind: i ? "apartment" : "building",
        hits: cache.hits - before[i].hits, misses: cache.misses - before[i].misses,
        entries: cache.size, bytes: cache.bytes })) }));
  }
}
