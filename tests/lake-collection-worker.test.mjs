import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { prepareLakeCandidate, collectPreparedLakePolygons } from "../src/water/LakeCollectionTask.ts";
import { createWaterBuildingOverlapFilter } from "../src/water/WaterBuildingOverlap.ts";
import { createWaterRoadOverlapFilter } from "../src/water/WaterRoadOverlap.ts";
import { clipToBounds, pointInRing } from "../src/core/PlanarGeometry.ts";

const bounds = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
const box = (x, z, width, depth, sourceId = "lake") => ({ sourceId, outline: [
  { x, z }, { x: x + width, z }, { x: x + width, z: z + depth }, { x, z: z + depth },
], holes: [] });
const inputFor = (waters, buildings = [], roads = []) => ({
  candidates: waters.map((water) => prepareLakeCandidate(water, bounds)).filter(Boolean),
  buildings, roads, metersPerUnit: 1, cellSize: 2,
});

// Original ordering: build indexes, reject whole provider polygons, then clip.
function reference(waters, input) {
  const buildings = createWaterBuildingOverlapFilter(input.buildings, input.cellSize, 0.15);
  const roads = createWaterRoadOverlapFilter(input.roads, input.metersPerUnit, input.cellSize);
  return waters.flatMap((water) => {
    if (buildings(water) || roads(water)) return [];
    const outline = clipToBounds(water.outline, bounds);
    if (outline.length < 3) return [];
    const holes = water.holes.map((ring) => clipToBounds(ring, bounds))
      .filter((ring) => ring.length >= 3 && pointInRing(ring[0], outline));
    return [{ sourceId: water.sourceId, outline, holes }];
  });
}

test("irrelevant water is culled and an empty collection never touches obstacles", () => {
  assert.equal(prepareLakeCandidate(box(20, 20, 5, 5), bounds), undefined);
  const input = { candidates: [], get buildings() { throw new Error("unnecessary buildings"); },
    get roads() { throw new Error("unnecessary roads"); } };
  assert.deepEqual(collectPreparedLakePolygons(input), []);
});

test("overlap rejection still uses full provider polygons, including obstacles outside the tile", () => {
  const water = box(0, 0, 100, 10);
  const input = inputFor([water], [box(20, 0, 30, 10)]);
  assert.equal(input.candidates[0].water, water);
  assert.deepEqual(collectPreparedLakePolygons(input), []);
  // Conversely, a small clipped fragment must not inflate the overlap fraction.
  const retained = inputFor([water], [box(0, 0, 5, 10)]);
  assert.equal(collectPreparedLakePolygons(retained).length, 1);
});

test("culling preserves original output for holes, duplicates, winding and road structures", () => {
  const appearance = { roadClass: "minor", widthMeters: 2, shoulderWidthMeters: 1,
    surface: "paved", visualStyle: "paved", structure: "surface", layer: 0, isTunnel: false };
  for (const structure of ["surface", "bridge", "ford"]) for (const reversed of [false, true]) {
    const lake = box(-5, -5, 20, 20);
    lake.holes = [box(2, 2, 3, 3).outline];
    if (reversed) { lake.outline.reverse(); lake.holes[0].reverse(); }
    const waters = [lake, lake, box(30, 30, 10, 10), box(6, 6, 2, 2, "pond")];
    const input = inputFor(waters, [box(2.5, 2.5, 1, 1)], [{ appearance: { ...appearance, structure },
      paths: [[{ x: -5, z: 7 }, { x: 15, z: 7 }]] }]);
    assert.deepEqual(collectPreparedLakePolygons(input), reference(waters, input));
  }
});

test("lake worker returns the reference geometry through real structured cloning", { timeout: 10_000 }, async (t) => {
  const worker = new Worker(new URL("./fixtures/lake-collection-worker.mjs", import.meta.url));
  t.after(() => worker.terminate());
  const waters = [box(-5, -5, 20, 20), box(1, 1, 1, 1, "pond")];
  const input = inputFor(waters, [box(0, 0, 3, 3)]);
  const response = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.postMessage({ id: 12, input });
  });
  assert.equal(response.ok, true);
  assert.deepEqual(response.output.lakes, reference(waters, input));
  assert.equal(response.output.timings[0].stage, "lake polygon overlap filtering");
});

test("game waits for lake work and cancels it wherever road work is cancelled", () => {
  const source = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
  assert.match(source, /await Promise\.all\(\[\s*this\.lakeCollectionWorker\.collect/);
  assert.match(source, /generation !== this\.streamingGeneration\) return undefined;\s*trace\?\.stage\("lake terrain shaping"\)/);
  assert.equal((source.match(/this\.lakeCollectionWorker\.reset\(\)/g) ?? []).length, 2);
  assert.match(source, /this\.lakeCollectionWorker\.dispose\(\)/);
});
