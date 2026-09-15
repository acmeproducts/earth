import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { worldTileBounds, worldTileAtLocation } from "../src/world/WorldGrid.ts";
import { lonLatToScene, sceneToLonLat } from "../src/world/Geo.ts";
import { planRoad } from "../src/roads/RoadPlanner.ts";
import { isSurfaceWaterFeature } from "../src/water/WaterFeatureVisibility.ts";
import { prepareLakeCandidate, collectPreparedLakePolygons } from "../src/water/LakeCollectionTask.ts";
import { createWaterBuildingOverlapFilter } from "../src/water/WaterBuildingOverlap.ts";
import { createWaterRoadOverlapFilter } from "../src/water/WaterRoadOverlap.ts";

// Replays provider geometry near the recorded lake stall, excluding network time.
// Raw building rings are shared by both paths; this isolates collection, not use inference.
const bounds = worldTileBounds({ level: 17, x: 69399, y: 38129 });
const meters = 2 * Math.PI * 6378137 / 2 ** 17 * Math.cos((bounds.latNorth + bounds.latSouth) / 2 * Math.PI / 180);
const meshWidth = 25;
const metersPerUnit = meters / meshWidth;
const nw = sceneToLonLat(-meters / 2 - 240, meters / 2 + 240, bounds, meters, meters);
const se = sceneToLonLat(meters / 2 + 240, -meters / 2 - 240, bounds, meters, meters);
const first = worldTileAtLocation(nw.lat, nw.lon, 14);
const last = worldTileAtLocation(se.lat, se.lon, 14);
const waters = [], buildings = [], roads = [];
const project = ([lon, lat]) => lonLatToScene(lon, lat, bounds, meshWidth, meshWidth);
const ring = (points) => {
  const [first, last] = [points[0], points.at(-1)];
  return (first[0] === last[0] && first[1] === last[1] ? points.slice(0, -1) : points).map(project);
};
await mkdir(".cache/lake-replay", { recursive: true });
for (let x = first.x; x <= last.x; x++) for (let y = first.y; y <= last.y; y++) {
  const file = `.cache/lake-replay/14-${x}-${y}.pbf`;
  let bytes;
  try { bytes = await readFile(file); } catch {
    const response = await fetch(`https://tiles.openfreemap.org/planet/latest/14/${x}/${y}.pbf`);
    if (!response.ok) throw new Error(`Map fetch ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(file, bytes);
  }
  const tile = new VectorTile(new PbfReader(bytes));
  for (const name of ["water", "building", "transportation"]) {
    const layer = tile.layers[name];
    for (let i = 0; i < (layer?.length ?? 0); i++) {
      const feature = layer.feature(i);
      const geometry = feature.toGeoJSON(x, y, 14).geometry;
      if (name === "transportation") {
        const appearance = planRoad(feature.properties);
        const paths = geometry.type === "LineString" ? [geometry.coordinates]
          : geometry.type === "MultiLineString" ? geometry.coordinates : [];
        if (appearance) roads.push({ appearance, paths: paths.map((path) => path.map(project)) });
        continue;
      }
      if (name === "water" && (feature.properties.class === "ocean" || !isSurfaceWaterFeature(feature.properties))) continue;
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates]
        : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
      for (const rings of polygons) {
        const shape = { sourceId: `${x}/${y}/${i}`, outline: ring(rings[0]), holes: rings.slice(1).map(ring) };
        (name === "water" ? waters : buildings).push(shape);
      }
    }
  }
}

const clipBounds = { minX: -12.5 - 240 / metersPerUnit, maxX: 12.5 + 240 / metersPerUnit,
  minZ: -12.5 - 240 / metersPerUnit, maxZ: 12.5 + 240 / metersPerUnit };
const input = { candidates: waters.map((water) => prepareLakeCandidate(water, clipBounds)).filter(Boolean),
  buildings, roads, metersPerUnit, cellSize: meshWidth / 8 };
function before() {
  const overlapsBuildings = createWaterBuildingOverlapFilter(buildings, input.cellSize, 0.15);
  const overlapsRoads = createWaterRoadOverlapFilter(roads, metersPerUnit, input.cellSize);
  return waters.filter((water) => !overlapsBuildings(water) && !overlapsRoads(water))
    .map((water) => prepareLakeCandidate(water, clipBounds)?.clipped).filter(Boolean);
}
function timed(operation) {
  const start = performance.now();
  const result = operation();
  return { result, milliseconds: performance.now() - start };
}
const baseline = timed(before);
const culled = timed(() => collectPreparedLakePolygons(input));
assert.deepEqual(culled.result, baseline.result);
const warmBaseline = [], warmCulled = [];
for (let i = 0; i < 5; i++) {
  warmBaseline.push(timed(before).milliseconds);
  const measurement = timed(() => collectPreparedLakePolygons(input));
  assert.deepEqual(measurement.result, baseline.result);
  warmCulled.push(measurement.milliseconds);
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const worker = new Worker(new URL("../tests/fixtures/lake-collection-worker.mjs", import.meta.url));
const run = (data) => new Promise((resolve, reject) => {
  worker.once("message", resolve);
  worker.once("error", reject);
  worker.postMessage({ id: 1, input: data });
});
try {
  await run({ ...input, candidates: [], buildings: [], roads: [] });
  let previous = performance.now(), maxHeartbeatGap = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxHeartbeatGap = Math.max(maxHeartbeatGap, now - previous);
    previous = now;
  }, 2);
  const start = performance.now();
  let response;
  try { response = await run(input); }
  finally { clearInterval(heartbeat); }
  maxHeartbeatGap = Math.max(maxHeartbeatGap, performance.now() - previous);
  assert.equal(response.ok, true);
  assert.deepEqual(response.output.lakes, baseline.result);
  console.log(JSON.stringify({ providerWaters: waters.length, relevantWaters: input.candidates.length,
    buildings: buildings.length, roads: roads.length, lakes: baseline.result.length,
    baselineMilliseconds: baseline.milliseconds, culledMilliseconds: culled.milliseconds,
    warmBaselineMedianMilliseconds: median(warmBaseline), warmCulledMedianMilliseconds: median(warmCulled),
    workerRoundTripMilliseconds: performance.now() - start,
    workerComputeMilliseconds: response.output.timings[0].durationMilliseconds,
    mainThreadMaxHeartbeatGapMilliseconds: maxHeartbeatGap, identicalOutput: true }, null, 2));
} finally { await worker.terminate(); }
