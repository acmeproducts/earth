// Manual verification helper for procedural terrain relief: loads the app under
// a low morning sun, measures how much sub-grid relief the native tile under
// the camera carries, and screenshots the ground from walking height.
// Run with: node tests/drive-terrain-relief.mjs [label] [time-of-day]
import { launchBrowser, sleep } from "./browser-harness.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const LABEL = process.argv[2] ?? "relief";
const TIME = process.argv[3] ?? "7";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9351;
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-relief";
const APP_URL = `http://localhost:3000/?date=2026-06-21&time=${TIME}`;

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
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.consoleAPICalled") {
    consoleLogs.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
  }

};
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
