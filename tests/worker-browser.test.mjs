import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

// Run after a development webpack build, with CHROME_BIN pointing to Chrome.
test("emitted road, lake and building workers load their chunks and compute in Chrome", {
  skip: !process.env.CHROME_BIN, timeout: 30_000,
}, async (t) => {
  let complete;
  const result = new Promise((done) => { complete = done; });
  const root = resolve("dist");
  const server = createServer(async (request, response) => {
    if (request.url === "/result") {
      let body = "";
      for await (const chunk of request) body += chunk;
      complete(JSON.parse(body));
      response.end("ok");
      return;
    }
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(`<script>
        const report = value => fetch('/result', { method: 'POST', body: JSON.stringify(value) });
        const worker = new Worker('/road-planning.js');
        worker.onerror = event => report({ error: event.message });
        worker.onmessage = event => {
          const road = event.data;
          const lakeWorker = new Worker('/lake-collection.js');
          lakeWorker.onerror = event => report({ error: event.message });
          lakeWorker.onmessage = event => {
            const lake = event.data;
            const buildingWorker = new Worker('/building-planning.js');
            buildingWorker.onerror = event => report({ error: event.message });
            let ticks = 0;
            const timer = setInterval(() => ticks++, 5);
            buildingWorker.onmessage = event => {
              clearInterval(timer);
              report({ road, lake, building: event.data, ticks });
            };
            buildingWorker.postMessage({ id: 9, input: { kind: 'building', input: {
              buildingType: 'house', buildingPolygon: { outer: [
                {x:0,y:0},{x:80,y:0},{x:80,y:60},{x:0,y:60}
              ], holes: [[{x:25,y:20},{x:55,y:20},{x:55,y:40},{x:25,y:40}]] }
            } } });
          };
          const water = { sourceId: 'pond', outline: [
            { x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }, { x: 0, z: 5 }
          ], holes: [] };
          lakeWorker.postMessage({ id: 8, input: { candidates: [{ water, clipped: water }],
            buildings: [], roads: [], metersPerUnit: 1, cellSize: 2 } });
        };
        worker.postMessage({ id: 7, input: {
          roads: [{ id: 'street', paths: [[{ x: -10, z: 0 }, { x: 10, z: 0 }]],
            appearance: { roadClass: 'minor', widthMeters: 2, shoulderWidthMeters: 1,
              surface: 'paved', visualStyle: 'paved', structure: 'surface', layer: 0, isTunnel: false } }],
          buildings: [], options: { meshWidth: 30, meshDepth: 30, metersPerUnit: 1 }
        } });
      </script>`);
      return;
    }
    const file = resolve(root, `.${request.url}`);
    if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    try {
      response.setHeader("Content-Type", "application/javascript");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const profile = await mkdtemp(join(tmpdir(), "earth-worker-smoke-"));
  const browser = spawn(process.env.CHROME_BIN, ["--headless", "--disable-gpu", "--no-first-run",
    `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`],
  { windowsHide: true, stdio: "ignore" });
  const exited = new Promise((done) => browser.once("close", done));
  browser.once("error", (error) => complete({ error: error.message }));
  t.after(async () => {
    browser.kill();
    await exited;
    // This directory was created exclusively for this browser process.
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep + "earth-worker-smoke-"));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  });
  const response = await result;
  assert.equal(response.road?.ok, true, JSON.stringify(response));
  assert.equal(response.road.id, 7);
  assert.ok(response.road.output.plan.roads.length > 0);
  assert.ok(response.road.output.plan.shoulders.length > 0);
  assert.equal(response.road.output.timings.length, 12);
  assert.equal(response.lake.ok, true);
  assert.equal(response.lake.id, 8);
  assert.equal(response.lake.output.lakes[0].sourceId, "pond");
  assert.equal(response.building.ok, true);
  assert.equal(response.building.id, 9);
  assert.ok(response.building.output.result.interior.building.rooms.length > 0);
  assert.ok(response.ticks > 0, "the page event loop must run while the building worker starts/plans");
});
