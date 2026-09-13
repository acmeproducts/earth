// Manual verification driver (not part of the test suite): drives the dev
// server at localhost:3000 in headless Chrome, screenshots the kapok source
// tree in the impostor demo, then loads an Amazon rainforest location in the
// game and screenshots the canopy. Run with: node tests/drive-jungle-shot.mjs
import { launchBrowser, sleep } from "./browser-harness.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9341;
const APP_URL = "http://localhost:3000/";
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-jungle";
const SPECIES = process.argv[2] ?? "kapok";
const LATITUDE = process.argv[3] ?? "-3.2";
const LONGITUDE = process.argv[4] ?? "-60.6";

mkdirSync(OUT_DIR, { recursive: true });

const { chrome, socket, send, evaluate } = await launchBrowser([
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${OUT_DIR}/profile`,
  "--headless=new",
  "--window-size=1600,900",
  "--enable-unsafe-swiftshader",
  "--no-first-run",
  "about:blank",
], CHROME);
const consoleLogs = [];
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.consoleAPICalled") {
    const text = message.params.args
      .map((argument) => argument.value ?? argument.description ?? "")
      .join(" ");
    consoleLogs.push(`[${message.params.type}] ${text}`);
  } else if (message.method === "Runtime.exceptionThrown") {
    consoleLogs.push(`[exception] ${JSON.stringify(message.params.exceptionDetails)}`);
  }
};

async function screenshot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT_DIR}/${name}.png`, Buffer.from(data, "base64"));
  console.log(`saved ${name}.png`);
}

async function key(type, keyName, code, keyCode) {
  await send("Input.dispatchKeyEvent", {
    type,
    key: keyName,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
}

async function waitForLoad(maxSeconds) {
  for (let attempt = 0; attempt < maxSeconds; attempt++) {
    if (await evaluate("!document.getElementById('loading') || document.getElementById('loading').classList.contains('hidden')")) return true;
    await sleep(1000);
  }
  return false;
}

await send("Runtime.enable");
await send("Page.enable");

// 1. The source tree in the impostor demo, from two orbit angles.
await send("Page.navigate", { url: `${APP_URL}?tree-impostor=${SPECIES}` });
console.log("demo loaded:", await waitForLoad(120));
await sleep(2500);
await screenshot(`${SPECIES}-source-a`);
await evaluate(`
  const canvas = document.getElementById('renderCanvas');
  const rect = canvas.getBoundingClientRect();
  canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.width / 2, clientY: rect.height / 2, button: 0, pointerId: 1, bubbles: true }));
  canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.width / 2 + 260, clientY: rect.height / 2 - 60, button: 0, pointerId: 1, bubbles: true }));
  canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.width / 2 + 260, clientY: rect.height / 2 - 60, button: 0, pointerId: 1, bubbles: true }));
`);
await sleep(1200);
await screenshot(`${SPECIES}-source-b`);

// 2. The rainforest in the game.
const demoLogCount = consoleLogs.length;
await send("Page.navigate", { url: APP_URL });
console.log("game loaded:", await waitForLoad(240));
await evaluate("document.getElementById('renderCanvas').focus()");
await sleep(2000);
await key("rawKeyDown", "Escape", "Escape", 27);
await key("keyUp", "Escape", "Escape", 27);
await sleep(300);
await evaluate(`
  document.querySelector('[aria-label="Latitude"]').value = '${LATITUDE}';
  document.querySelector('[aria-label="Longitude"]').value = '${LONGITUDE}';
  document.querySelector('.coordinate-form').requestSubmit();
`);
for (let attempt = 0; attempt < 240; attempt++) {
  const newLogs = consoleLogs.slice(demoLogCount);
  if (newLogs.some((line) => line.includes("OSM:"))) break;
  await sleep(1000);
}
await sleep(6000);

// Reach the live scene through the webpack module cache.
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
// Tile meshes are 25 units across a zoom-16 tile, about 610 m near the equator.
const UNITS_PER_METER = 25 / 610;
const pose = async (dy, pitch, yaw) => evaluate(`(() => {
  const camera = window.__earthScene.activeCamera;
  camera.position.y = window.__walkY + ${dy};
  camera.rotation.x = ${pitch};
  camera.rotation.y = ${yaw};
  camera.cameraRotation?.setAll(0);
  return [camera.position.x, camera.position.y, camera.position.z];
})()`);

// Walking height first: this settles the camera onto the ground.
await evaluate("document.getElementById('renderCanvas').focus()");
await key("rawKeyDown", "g", "KeyG", 71);
await key("keyUp", "g", "KeyG", 71);
await sleep(5000);
await evaluate("window.__walkY = window.__earthScene.activeCamera.position.y");
await pose(0, -0.02, 0.4);
await sleep(1500);
await screenshot("jungle-ground-a");
await pose(0, -0.05, 2.1);
await sleep(1500);
await screenshot("jungle-ground-b");

// Back to flight for canopy-level and aerial views.
await key("rawKeyDown", "g", "KeyG", 71);
await key("keyUp", "g", "KeyG", 71);
await sleep(1000);
await pose(9 * UNITS_PER_METER, 0.08, 0.9);
await sleep(2500);
await screenshot("jungle-canopy");
await pose(45 * UNITS_PER_METER, 0.5, 0.9);
await sleep(2500);
await screenshot("jungle-aerial");
await pose(140 * UNITS_PER_METER, 0.75, 3.5);
await sleep(2500);
await screenshot("jungle-high");

writeFileSync(`${OUT_DIR}/console.log`, consoleLogs.join("\n"));
const problems = consoleLogs.filter((line) => /\[(error|exception)\]/.test(line));
console.log(`console errors: ${problems.length}`);
for (const line of problems.slice(0, 10)) console.log(line.slice(0, 400));
console.log("done");
socket.close();
chrome.kill();
