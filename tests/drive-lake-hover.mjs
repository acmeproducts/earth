// Diagnostic driver: loads the game at a lake-dense location with
// `?lake-debug`, lets tiles stream, walks the camera across neighbouring tiles
// and collects every `[lake-debug]` warning (rendered ground below a lake
// outline) plus a top-down screenshot.
// Run with: node tests/drive-lake-hover.mjs [lat] [lon] [--steps N] [--hold]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = Number(process.env.LAKE_PORT ?? 9371);
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-lake";
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const lat = Number(positional[0] ?? 59.58990531228428);
const lon = Number(positional[1] ?? 13.783101006047959);
const stepsIndex = process.argv.indexOf("--steps");
const steps = stepsIndex === -1 ? 3 : Number(process.argv[stepsIndex + 1]);
const label = `${lat.toFixed(3)}_${lon.toFixed(3)}`;

mkdirSync(OUT_DIR, { recursive: true });
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${OUT_DIR}/profile-${DEBUG_PORT}`,
  "--headless=new",
  "--window-size=1280,800",
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
const lakeLines = [];
const otherLines = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
  if (message.method === "Runtime.consoleAPICalled") {
    const text = message.params.args.map((a) => a.value ?? a.description).join(" ");
    if (text.includes("[lake-debug]")) lakeLines.push(text);
    else if (/World frame|Error|failed|context lost|Unable/i.test(text)) otherLines.push(text.slice(0, 400));
  }
  if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    otherLines.push(`uncaught: ${details.exception?.description ?? details.text}`.slice(0, 600));
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
async function waitForScene() {
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = await evaluate(`(() => {
      const loading = document.getElementById("loading");
      const text = loading ? loading.innerText : "";
      if (/unable/i.test(text)) return "failed: " + text.replace(/\\s+/g, " ").slice(0, 200);
      const hidden = !loading || loading.hidden || getComputedStyle(loading).display === "none" ||
        getComputedStyle(loading).opacity === "0";
      return document.querySelector(".place-form") && hidden ? "ready" : "loading";
    })()`);
    if (state === "ready") return;
    if (state.startsWith("failed")) throw new Error(state);
    if (attempt % 20 === 0) console.log("waiting for scene", attempt);
    await sleep(1000);
  }
  throw new Error("scene never finished loading");
}

await send("Runtime.enable");
await send("Page.enable");
// Seed the persisted location on the app origin, then load with diagnostics on.
await send("Page.navigate", { url: "http://localhost:3000/?lake-debug" });
await sleep(3000);
await evaluate(`localStorage.setItem("earth.location.v1", JSON.stringify({ lat: ${lat}, lon: ${lon} }))`);
await send("Page.navigate", { url: "http://localhost:3000/?lake-debug" });
await waitForScene();
console.log("scene ready; streaming settle");
await sleep(40000);

const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const file = `${OUT_DIR}/${label}-${name}.png`;
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log("screenshot", file);
};

try {
  console.log("scene grab:", await evaluate(`(() => {
    const chunkKey = Object.keys(window).find((key) => key.startsWith("webpackChunk"));
    let req;
    window[chunkKey].push([["lake-probe"], {}, (r) => { req = r; }]);
    const scene = Object.values(req.c)
      .map((module) => module?.exports?.EngineStore?.LastCreatedScene)
      .find(Boolean);
    window.__earthScene = scene ?? null;
    return scene ? "ok" : "no scene";
  })()`));

  await evaluate(`(() => {
    const slider = document.querySelector('input[aria-label="Time of day"]');
    if (slider) { slider.value = "12"; slider.dispatchEvent(new Event("input", { bubbles: true })); }
    document.getElementById("sceneControls")?.style.setProperty("display", "none");
    return true;
  })()`);
  await sleep(2000);
  await shot("start");

  // Walk one tile east per step so neighbours stream as native and far tiles.
  for (let step = 1; step <= steps; step++) {
    const moved = await evaluate(`(() => {
      const camera = window.__earthScene && window.__earthScene.activeCamera;
      if (!camera) return "no camera";
      camera.position.x += 25;
      return camera.position.asArray().map((v) => v.toFixed(1)).join(",");
    })()`);
    console.log(`step ${step}: moved east one tile -> ${moved}`);
    await sleep(35000);
  }
  await shot("end");
  // Aerial view for a visual check of shorelines around the final position.
  await evaluate(`(() => {
    const camera = window.__earthScene && window.__earthScene.activeCamera;
    if (!camera) return "no camera";
    camera.position.y += 10;
    camera.rotation.x = 0.75;
    return "aerial";
  })()`);
  await sleep(3000);
  await shot("aerial");
} catch (error) {
  console.error("driver failed:", error.message);
} finally {
  console.log(`\n== lake-debug lines (${lakeLines.length}) ==`);
  for (const line of lakeLines) console.log(line.replace("[lake-debug] ", ""));
  console.log(`\n== other (${otherLines.length}) ==`);
  for (const line of otherLines) console.log(line);
  writeFileSync(`${OUT_DIR}/${label}-lake-debug.log`, lakeLines.join("\n"));
}

if (process.argv.includes("--hold")) {
  console.log(`holding on port ${DEBUG_PORT}; Ctrl+C to exit`);
  await new Promise((resolve) => process.once("SIGINT", resolve));
}
socket.close();
chrome.kill();
