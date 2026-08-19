// Manual repro/verification driver (not part of the test suite): drives the
// dev server at localhost:3000 in headless Chrome, teleports the camera across
// a world-tile boundary to trigger terrain streaming, and captures screenshots
// plus scene state to diagnose vegetation/water issues.
// Run with: node tests/drive-tile-streaming.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9338;
const APP_URL = "http://localhost:3000/";
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-stream";

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
console.log("app initialized");
await sleep(2000);

// Reach the live Babylon scene through the webpack module cache.
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
  const byName = (name) => scene.meshes.filter((mesh) => mesh.name === name);
  const vegetationMeshes = scene.meshes.filter((mesh) =>
    (mesh.thinInstanceCount ?? 0) > 0);
  const enabledVegetation = vegetationMeshes.filter((mesh) => mesh.isEnabled());
  const roots = {};
  for (const node of scene.transformNodes) {
    if (["treeField", "grassField", "flowerField", "bushField", "mapFeatures"].includes(node.name)) {
      (roots[node.name] ??= []).push({
        enabled: node.isEnabled(),
        position: { x: node.position.x, z: node.position.z },
      });
    }
  }
  return {
    camera: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    terrains: byName("terrain").map((mesh) => ({
      enabled: mesh.isEnabled(),
      position: { x: mesh.position.x, z: mesh.position.z },
      disposed: mesh.isDisposed(),
    })),
    water: byName("waterMesh").map((mesh) => ({
      enabled: mesh.isEnabled(),
      position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
    })),
    vegetationMeshCount: vegetationMeshes.length,
    enabledVegetationMeshCount: enabledVegetation.length,
    enabledVegetationInstances: enabledVegetation.reduce(
      (total, mesh) => total + mesh.thinInstanceCount, 0),
    roots,
    totalMeshes: scene.meshes.length,
  };
})()`);

console.log("initial state:", JSON.stringify(await snapshot(), null, 2));
await screenshot("stream-0-initial");

// Teleport east past the center of the neighboring tile to force a new
// 2x2 window selection (tile centers sit at ±25 units in the initial frame).
const logCountBefore = consoleLogs.length;
await evaluate("window.__earthScene.activeCamera.position.x = 35; true");
console.log("teleported to x=35, waiting for streaming...");

let streamed = false;
for (let attempt = 0; attempt < 300; attempt++) {
  const fresh = consoleLogs.slice(logCountBefore);
  if (fresh.some((line) => line.includes("Streaming terrain window"))) streamed = true;
  if (streamed && fresh.some((line) => line.includes("OSM:"))) break;
  if (fresh.some((line) => line.includes("Failed to stream"))) break;
  await sleep(1000);
}
await sleep(3000);
console.log("post-stream state:", JSON.stringify(await snapshot(), null, 2));
await screenshot("stream-1-after-first");

// Cross one more boundary to catch issues that only appear on the second hop.
const secondLogCount = consoleLogs.length;
await evaluate("window.__earthScene.activeCamera.position.x = 85; true");
console.log("teleported to x=85, waiting for streaming...");
for (let attempt = 0; attempt < 300; attempt++) {
  const fresh = consoleLogs.slice(secondLogCount);
  if (fresh.some((line) => line.includes("OSM:")) ||
      fresh.some((line) => line.includes("Failed to stream"))) break;
  await sleep(1000);
}
await sleep(3000);
console.log("post-second-stream state:", JSON.stringify(await snapshot(), null, 2));
await screenshot("stream-2-after-second");

writeFileSync(`${OUT_DIR}/console.log`, consoleLogs.join("\n"));
console.log("done");
socket.close();
chrome.kill();
