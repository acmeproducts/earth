// Manual verification helper: loads the app, lifts the camera, points it at
// the horizon, waits for the streamed radius to fill, and screenshots it.
// Run with: node tests/drive-horizon-shot.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9339;
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-stream";

mkdirSync(OUT_DIR, { recursive: true });
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${OUT_DIR}/profile-horizon`,
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
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500));
  return result.result?.value;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: "http://localhost:3000/" });
for (let attempt = 0; attempt < 240; attempt++) {
  if (await evaluate("!document.getElementById('loading')")) break;
  await sleep(1000);
}
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
})()`);
// Lift above the forest and level the view at the horizon.
await evaluate(`(() => {
  const camera = window.__earthScene.activeCamera;
  camera.position.set(0, 12, -6);
  camera.rotation.set(0.05, 0.4, 0);
  return true;
})()`);
// Give the streamed radius time to fill.
for (let elapsed = 0; elapsed < 120; elapsed += 5) {
  await sleep(5000);
  const tiles = await evaluate(
    `window.__earthScene.meshes.filter((mesh) => mesh.name.startsWith("terrain ")).length`,
  );
  console.log(`${elapsed + 5}s: tiles=${tiles}`);
  if (tiles >= 289) break;
}
await sleep(10000);
const { data } = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${OUT_DIR}/horizon.png`, Buffer.from(data, "base64"));
console.log("done");
socket.close();
chrome.kill();
