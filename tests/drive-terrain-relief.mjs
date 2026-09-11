// Manual verification helper for procedural terrain relief: loads the app under
// a low morning sun, measures how much sub-grid relief the native tile under
// the camera carries, and screenshots the ground from walking height.
// Run with: node tests/drive-terrain-relief.mjs [label] [time-of-day]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const LABEL = process.argv[2] ?? "relief";
const TIME = process.argv[3] ?? "7";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9351;
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-relief";
const APP_URL = `http://localhost:3000/?date=2026-06-21&time=${TIME}`;

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
      const page = (await response.json()).find((target) => target.type === "page");
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome debug endpoint never came up");
}

const target = await getTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 1;
const pending = new Map();
const consoleLogs = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.consoleAPICalled") {
    consoleLogs.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
  }
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800));
  return result.result?.value;
}
async function key(type, keyName, code, keyCode) {
  await send("Input.dispatchKeyEvent", { type, key: keyName, code, windowsVirtualKeyCode: keyCode });
}
async function screenshot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const path = `${OUT_DIR}/${name}.png`;
  writeFileSync(path, Buffer.from(data, "base64"));
  console.log("wrote", path);
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: APP_URL });
for (let attempt = 0; attempt < 240; attempt++) {
  if (await evaluate("!document.getElementById('loading') || document.getElementById('loading').classList.contains('hidden')")) break;
  await sleep(1000);
}
await sleep(4000);

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

// Walking height settles the camera onto the ground.
await evaluate("document.getElementById('renderCanvas').focus()");
await key("rawKeyDown", "Escape", "Escape", 27);
await key("keyUp", "Escape", "Escape", 27);
await sleep(300);
await key("rawKeyDown", "g", "KeyG", 71);
await key("keyUp", "g", "KeyG", 71);
await sleep(6000);

// Measure the tile under the camera: vertex grid, and the RMS of each height
// against the mean of its four neighbours, which is what the provider raster
// alone leaves near zero.
const metrics = await evaluate(`(() => {
  const scene = window.__earthScene;
  const camera = scene.activeCamera;
  const latitude = Number(document.querySelector('[aria-label="Latitude"]')?.value);
  const tiles = scene.meshes.filter((mesh) => mesh.name.startsWith("terrain ") && !mesh.name.endsWith("skirt"));
  const under = tiles.find((mesh) => {
    const box = mesh.getBoundingInfo().boundingBox;
    return camera.position.x >= box.minimumWorld.x && camera.position.x <= box.maximumWorld.x &&
      camera.position.z >= box.minimumWorld.z && camera.position.z <= box.maximumWorld.z;
  });
  if (!under) return { error: "no tile under camera", tiles: tiles.length };
  const positions = under.getVerticesData("position");
  const perRow = Math.round(Math.sqrt(positions.length / 3));
  const box = under.getBoundingInfo().boundingBox;
  const widthUnits = box.maximumWorld.x - box.minimumWorld.x;
  const tileMeters = 40075016.686 / 65536 * Math.cos(latitude * Math.PI / 180);
  const metersPerUnit = tileMeters / widthUnits;
  let sum = 0; let count = 0; let maxAbs = 0;
  for (let row = 1; row < perRow - 1; row++) {
    for (let column = 1; column < perRow - 1; column++) {
      const h = (r, c) => positions[(r * perRow + c) * 3 + 1];
      const residual = h(row, column) - (h(row - 1, column) + h(row + 1, column) + h(row, column - 1) + h(row, column + 1)) / 4;
      sum += residual * residual; count++;
      maxAbs = Math.max(maxAbs, Math.abs(residual));
    }
  }
  return {
    tile: under.name,
    latitude,
    verticesPerRow: perRow,
    metersPerVertex: tileMeters / (perRow - 1),
    residualRmsMeters: Math.sqrt(sum / count) * metersPerUnit,
    residualMaxMeters: maxAbs * metersPerUnit,
    tiles: tiles.length,
  };
})()`);
console.log(JSON.stringify(metrics, null, 2));

const pose = async (pitch, yaw) => evaluate(`(() => {
  const camera = window.__earthScene.activeCamera;
  camera.rotation.x = ${pitch};
  camera.rotation.y = ${yaw};
  camera.cameraRotation?.setAll(0);
  return true;
})()`);
// Hides the ground-cover layers so the terrain surface itself can be judged.
const bare = (hidden) => evaluate(`(() => {
  for (const mesh of window.__earthScene.meshes) {
    if (/grass|fern|bush|plant|wheat|sapling|rock/i.test(mesh.name)) mesh.isVisible = ${!hidden};
  }
  return true;
})()`);
await pose(0.22, 0.6);
await sleep(2500);
await screenshot(`${LABEL}-ground-a`);
await pose(0.12, 2.4);
await sleep(2500);
await screenshot(`${LABEL}-ground-b`);
await bare(true);
await sleep(1500);
await screenshot(`${LABEL}-bare-b`);
await pose(0.35, 4.0);
await sleep(1500);
await screenshot(`${LABEL}-bare-c`);
await bare(false);

const relevant = consoleLogs.filter((line) => /unit =|elevation range|WebGL|Error/i.test(line));
console.log(relevant.slice(0, 12).join("\n"));
socket.close();
chrome.kill();
