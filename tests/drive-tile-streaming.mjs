// Manual repro/verification driver (not part of the test suite): drives the
// dev server at localhost:3000 in headless Chrome and verifies the per-tile
// terrain streaming: tiles fill outward, the detail ring follows the camera,
// and tiles left behind cool down and get evicted.
// Run with: node tests/drive-tile-streaming.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9338;
const APP_URL = "http://localhost:3000/";
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-stream";
const TILE_UNITS = 25;

mkdirSync(OUT_DIR, { recursive: true });

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${OUT_DIR}/profile`,
  "--headless=new",
  "--window-size=1600,900",
  "--enable-unsafe-swiftshader",
  "--no-first-run",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getTarget() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome debug endpoint never came up");
}

const target = await getTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

let nextId = 1;
const pending = new Map();
const consoleLogs = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  } else if (message.method === "Runtime.consoleAPICalled") {
    const text = message.params.args
      .map((argument) => argument.value ?? argument.description ?? "")
      .join(" ");
    consoleLogs.push(`[${message.params.type}] ${text}`);
  } else if (message.method === "Runtime.exceptionThrown") {
    consoleLogs.push(`[exception] ${JSON.stringify(message.params.exceptionDetails)}`);
  }
};

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(`page exception: ${JSON.stringify(result.exceptionDetails).slice(0, 800)}`);
  }
  return result.result?.value;
}

async function screenshot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT_DIR}/${name}.png`, Buffer.from(data, "base64"));
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: APP_URL });

for (let attempt = 0; attempt < 240; attempt++) {
  if (await evaluate("!document.getElementById('loading')")) break;
  await sleep(1000);
}
console.log("app initialized (center tile ready)");

await evaluate(`(() => {
  const chunkKey = Object.keys(window).find((key) => key.startsWith("webpackChunk"));
  let req;
  window[chunkKey].push([["earth-probe"], {}, (r) => { req = r; }]);
  for (const id of Object.keys(req.c)) {
    const exportsObject = req.c[id]?.exports;
    if (exportsObject && exportsObject.EngineStore) {
      window.__earthScene = exportsObject.EngineStore.LastCreatedScene;
      return true;
    }
  }
  throw new Error("EngineStore not found in module cache");
})()`);

const snapshot = async () => evaluate(`(() => {
  const scene = window.__earthScene;
  const camera = scene.activeCamera;
  const terrainTiles = scene.meshes
    .filter((mesh) => mesh.name.startsWith("terrain "))
    .map((mesh) => ({
      key: mesh.name.slice("terrain ".length),
      x: Number(mesh.name.split("/")[1]),
      y: Number(mesh.name.split("/")[2]),
      enabled: mesh.isEnabled(),
      position: { x: Math.round(mesh.position.x), z: Math.round(mesh.position.z) },
    }));
  const detailTiles = scene.transformNodes.filter((node) => node.name === "treeField").length;
  const water = scene.getMeshByName("waterMesh");
  const vegetationInstances = scene.meshes.reduce(
    (total, mesh) => total + (mesh.isEnabled() ? (mesh.thinInstanceCount ?? 0) : 0), 0);
  const xs = terrainTiles.map((tile) => tile.x);
  return {
    camera: { x: Math.round(camera.position.x), z: Math.round(camera.position.z) },
    tileCount: terrainTiles.length,
    tileXRange: xs.length ? [Math.min(...xs), Math.max(...xs)] : null,
    detailTiles,
    vegetationInstances,
    water: water ? { x: Math.round(water.position.x), z: Math.round(water.position.z) } : null,
    fogMode: scene.fogMode,
    totalMeshes: scene.meshes.length,
  };
})()`);

// Phase 1: let the world fill outward around the spawn.
let filled;
for (let elapsed = 0; elapsed < 240; elapsed += 5) {
  await sleep(5000);
  filled = await snapshot();
  console.log(`fill ${elapsed + 5}s: tiles=${filled.tileCount} detail=${filled.detailTiles} veg=${filled.vegetationInstances}`);
  if (filled.tileCount >= 280 && filled.detailTiles >= 20) break;
}
console.log("after fill:", JSON.stringify(filled));
await screenshot("tiles-1-filled");

// Phase 2: move ten tiles east and let streaming follow.
await evaluate(`window.__earthScene.activeCamera.position.x += ${10 * TILE_UNITS}; true`);
console.log("teleported 10 tiles east");
let moved;
for (let elapsed = 0; elapsed < 240; elapsed += 5) {
  await sleep(5000);
  moved = await snapshot();
  console.log(`follow ${elapsed + 5}s: tiles=${moved.tileCount} range=${JSON.stringify(moved.tileXRange)} detail=${moved.detailTiles}`);
  if (moved.tileXRange && moved.tileXRange[1] - filled.tileXRange[1] >= 9 && moved.detailTiles >= 20) break;
}
console.log("after move:", JSON.stringify(moved));
await screenshot("tiles-2-moved");

// Phase 3: wait past the cooldown and confirm tiles behind us were evicted.
await sleep(45000);
const cooled = await snapshot();
console.log("after cooldown:", JSON.stringify(cooled));
await screenshot("tiles-3-cooled");

const contextLost = consoleLogs.some((line) => line.includes("context lost"));
const errors = consoleLogs.filter((line) => line.startsWith("[error]") || line.startsWith("[exception]"));
console.log(`context lost: ${contextLost}`);
console.log(`errors: ${errors.length}`);
errors.slice(0, 10).forEach((line) => console.log(line));
console.log(`tiles before cooldown: ${moved.tileCount}, after: ${cooled.tileCount}`);

writeFileSync(`${OUT_DIR}/console.log`, consoleLogs.join("\n"));
console.log("done");
socket.close();
chrome.kill();
