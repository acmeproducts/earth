import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { writeFile } from "node:fs/promises";
import { buildingLayoutCache } from "../src/buildings/BuildingLayoutPlanner.ts";
import { apartmentLayoutCache } from "../src/buildings/ApartmentLayoutPlanner.ts";

// Replay captured renderer requests without meshes, worker startup, or frame waits.
export async function profilePlanningRequests(inputs, runTask) {
  assert.ok(inputs.length, "No planning requests captured");
  const clearCaches = () => { buildingLayoutCache.clear(); apartmentLayoutCache.clear(); };
  clearCaches();
  const baseline = inputs.map((input) => runTask(input).result);
  const rows = inputs.map((input, index) => ({
    index, kind: input.kind,
    vertices: (input.input?.buildingPolygon ?? input.building.boundary).outer.length,
    apartments: input.building?.rooms.filter((room) => room.type === "apartment").length,
    failure: baseline[index].failure,
    times: [],
  }));
  // Measure without the sampling profiler, checking outputs outside timed calls.
  for (let repeat = 0; repeat < 5; repeat++) {
    clearCaches();
    for (const [index, input] of inputs.entries()) {
      const output = runTask(input);
      rows[index].times.push(output.timings[0].durationMilliseconds);
      assert.deepEqual(output.result, baseline[index]);
    }
  }
  const session = new Session();
  session.connect();
  let profile;
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: 500 });
    await session.post("Profiler.start");
    for (let repeat = 0; repeat < 5; repeat++) {
      clearCaches();
      for (const input of inputs) runTask(input);
    }
    ({ profile } = await session.post("Profiler.stop"));
  } finally { session.disconnect(); }
  const round = (value) => +value.toFixed(3);
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const unique = new Set(inputs.map((input) => JSON.stringify(input)));
  const summary = {
    requests: inputs.length, uniqueExactInputs: unique.size, measuredRuns: 5,
    groups: ["building", "apartments"].map((kind) => {
      const selected = rows.filter((row) => row.kind === kind);
      return { kind, requests: selected.length,
        medianTotalMs: round(median(Array.from({ length: 5 }, (_, i) => selected.reduce((sum, row) => sum + row.times[i], 0)))) };
    }),
    requestsByCost: rows.map(({ times, ...row }) => ({ ...row,
      medianMs: round(median(times)), maxMs: round(Math.max(...times)),
    })).sort((a, b) => b.medianMs - a.medianMs),
    hotspots: summarizeProfile(profile),
  };
  await writeFile(".building-planning-inputs.json", JSON.stringify(inputs));
  await writeFile("building-planning.cpuprofile", JSON.stringify(profile));
  await writeFile(".building-planning-summary.json", JSON.stringify(summary, null, 2));
  console.log("[Planning profile] " + JSON.stringify(summary, null, 2));
}

function summarizeProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const functions = new Map();
  let totalMs = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const ms = profile.timeDeltas[i] / 1000;
    totalMs += ms;
    let id = profile.samples[i];
    const seen = new Set();
    let leaf = true;
    while (id !== undefined) {
      const frame = nodes.get(id).callFrame;
      const key = `${frame.url}:${frame.lineNumber}:${frame.functionName}`;
      const entry = functions.get(key) ?? { function: frame.functionName || "(anonymous)",
        file: frame.url, line: frame.lineNumber + 1, selfMs: 0, inclusiveMs: 0 };
      if (leaf) entry.selfMs += ms;
      if (!seen.has(key)) entry.inclusiveMs += ms;
      functions.set(key, entry);
      seen.add(key);
      leaf = false;
      id = parents.get(id);
    }
  }
  const ranked = (field) => [...functions.values()].sort((a, b) => b[field] - a[field]).slice(0, 35)
    .map((row) => ({ ...row, selfMs: +row.selfMs.toFixed(2), inclusiveMs: +row.inclusiveMs.toFixed(2) }));
  return { totalMs, self: ranked("selfMs"), inclusive: ranked("inclusiveMs") };
}
