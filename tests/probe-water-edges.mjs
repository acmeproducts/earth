// Throwaway diagnostic: zooms into the frame edges and the shoreline so the
// black border rows and the reflection bleed can be seen and bisected.
// Run with: node tests/probe-water-edges.mjs [--no-reflections] [--tune '{...}'] [--label name]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9347;
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-stream";
const reflectionsOff = process.argv.includes("--no-reflections");
const tuneIndex = process.argv.indexOf("--tune");
const tuning = tuneIndex === -1 ? null : process.argv[tuneIndex + 1];
const viewIndex = process.argv.indexOf("--view");
const view = viewIndex === -1
  ? { x: 30, y: 0.6, z: 0, pitch: 0.04, yaw: -Math.PI / 2 }
  : JSON.parse(process.argv[viewIndex + 1]);
const labelIndex = process.argv.indexOf("--label");
const label = labelIndex !== -1 ? process.argv[labelIndex + 1] : reflectionsOff ? "off" : "on";
const WIDTH = 1280;
const HEIGHT = 720;

mkdirSync(OUT_DIR, { recursive: true });
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${OUT_DIR}/profile-edges`,
  "--headless=new",
  `--window-size=${WIDTH},${HEIGHT}`,
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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 900));
  return result.result?.value;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: `http://localhost:3000/${reflectionsOff ? "?reflections=off" : ""}` });
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
await evaluate(`(() => {
  const slider = document.querySelector('#sceneControls input[type="range"][aria-label="Time of day"]');
  if (slider) { slider.value = "17"; slider.dispatchEvent(new Event("input", { bubbles: true })); }
  // Hide the overlays so they cannot be mistaken for render artefacts.
  for (const id of ["sceneControls"]) document.getElementById(id)?.style.setProperty("display", "none");
  return true;
})()`);
await sleep(35000);
await evaluate(`(() => {
  const camera = window.__earthScene.activeCamera;
  camera.position.set(${view.x}, ${view.y}, ${view.z});
  camera.rotation.set(${view.pitch}, ${view.yaw}, 0);
  return true;
})()`);

if (tuning) {
  console.log(await evaluate(`(() => {
    const pipeline = window.__earthScene.postProcessRenderPipelineManager.supportedPipelines
      .find((p) => (p._name ?? p.name) === "waterReflections");
    if (!pipeline) return "no pipeline";
    Object.assign(pipeline, ${tuning});
    return "tuned " + JSON.stringify(${tuning});
  })()`));
}
await sleep(4000);

console.log(await evaluate(`(() => {
  const scene = window.__earthScene;
  const engine = scene.getEngine();
  const pipeline = scene.postProcessRenderPipelineManager.supportedPipelines
    .find((p) => (p._name ?? p.name) === "waterReflections");
  const sizes = (scene.activeCamera._postProcesses || []).filter(Boolean).map((p) =>
    p.name + "=" + (p.inputTexture ? p.inputTexture.width + "x" + p.inputTexture.height : "?"));
  return JSON.stringify({
    render: engine.getRenderWidth() + "x" + engine.getRenderHeight(),
    prepass: scene.prePassRenderer ? scene.prePassRenderer.getRenderTarget().getSize() : null,
    postProcesses: sizes,
    ssrDownsample: pipeline?.ssrDownsample,
    blurDownsample: pipeline?.blurDownsample,
  });
})()`));

// Row means straight off the drawing buffer, sampled inside the render loop
// before the browser clears it.
console.log(await evaluate(`(async () => {
  const scene = window.__earthScene;
  const source = scene.getEngine().getRenderingCanvas();
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  const context = copy.getContext("2d");
  await new Promise((resolve) => {
    const observer = scene.onAfterRenderObservable.add(() => {
      context.drawImage(source, 0, 0);
      scene.onAfterRenderObservable.remove(observer);
      resolve();
    });
  });
  const rowMean = (y) => {
    const row = context.getImageData(0, y, copy.width, 1).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < row.length; i += 4) { r += row[i]; g += row[i + 1]; b += row[i + 2]; }
    const n = row.length / 4;
    return [r / n, g / n, b / n].map((v) => Math.round(v)).join(",");
  };
  const columnMean = (x) => {
    const column = context.getImageData(x, 0, 1, copy.height).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < column.length; i += 4) { r += column[i]; g += column[i + 1]; b += column[i + 2]; }
    const n = column.length / 4;
    return [r / n, g / n, b / n].map((v) => Math.round(v)).join(",");
  };
  const h = copy.height, w = copy.width;
  return JSON.stringify({
    size: w + "x" + h,
    topRows: [0, 1, 2, 3, 10].map((y) => y + ":" + rowMean(y)),
    bottomRows: [h - 11, h - 4, h - 3, h - 2, h - 1].map((y) => y + ":" + rowMean(y)),
    leftColumns: [0, 1, 2, 10].map((x) => x + ":" + columnMean(x)),
    rightColumns: [w - 11, w - 3, w - 2, w - 1].map((x) => x + ":" + columnMean(x)),
  }, null, 1);
})()`));

// Clip against the canvas, not the window: the two are not the same size.
const canvas = await evaluate(`(() => {
  const rect = document.querySelector("canvas").getBoundingClientRect();
  return JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
})()`);
const { x: cx, y: cy, width: cw, height: ch } = JSON.parse(canvas);
console.log("canvas rect", canvas);
const shots = [
  ["full", undefined],
  ["top", { x: cx, y: cy, width: cw, height: 8, scale: 6 }],
  ["bottom", { x: cx, y: cy + ch - 8, width: cw, height: 8, scale: 6 }],
  ["left", { x: cx, y: cy + ch / 2 - 100, width: 8, height: 200, scale: 6 }],
  ["right", { x: cx + cw - 8, y: cy + ch / 2 - 100, width: 8, height: 200, scale: 6 }],
  ["shoreline", { x: cx + 250, y: cy + 230, width: 500, height: 120, scale: 2 }],
];
for (const [name, clip] of shots) {
  const { data } = await send("Page.captureScreenshot", clip ? { format: "png", clip } : { format: "png" });
  writeFileSync(`${OUT_DIR}/edges-${label}-${name}.png`, Buffer.from(data, "base64"));
}
console.log("done", label);
socket.close();
chrome.kill();
