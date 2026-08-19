// Manual repro/verification driver (not part of the test suite): drives the
// dev server at localhost:3000 in headless Chrome, switches to Gaustatoppen,
// and checks that every streamed terrain tile's bounding volume actually
// encloses its surface.
//
// CreateGround leaves the bounds flat at y = 0 while the vertices carry
// absolute elevation, so on a 1883 m summit the geometry sits ~150 scene units
// above bounds that still describe sea level, and the frustum test drops the
// tile. This reports both the real culling and what the flat bounds would have
// culled from the same camera.
//
// Run with: node tests/drive-mountain-tile-visibility.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9339;
const APP_URL = "http://localhost:3000/";
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-mountain";
/** Gaustatoppen is the sixth example location, bound to the "6" key. */
const GAUSTATOPPEN_KEY = "6";

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

async function key(keyName, code, keyCode) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: keyName,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  }
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

// The scene only takes keyboard input once the canvas has focus.
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 800, y: 450, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 800, y: 450, button: "left", clickCount: 1 });
await key(GAUSTATOPPEN_KEY, `Digit${GAUSTATOPPEN_KEY}`, 48 + Number(GAUSTATOPPEN_KEY));
console.log("switched to Gaustatoppen");

/**
 * Compares each terrain tile's bounding volume against the surface it
 * describes, and re-runs the frustum test against the flat bounds the mesh
 * would have carried without the fix.
 */
const inspect = async () => evaluate(`(() => {
  const scene = window.__earthScene;
  const camera = scene.activeCamera;
  const planes = scene.frustumPlanes;
  const activeMeshes = scene.getActiveMeshes();
  const active = new Set();
  for (let index = 0; index < activeMeshes.length; index++) active.add(activeMeshes.data[index].uniqueId);

  const sphereInFrustum = (center, radius) =>
    planes.every((plane) => plane.dotCoordinate(center) > -radius);

  let tiles = 0;
  let boundsMatchSurface = 0;
  let visible = 0;
  let visibleWithFlatBounds = 0;
  let worstBoundsErrorUnits = 0;
  let surfaceLow = Infinity;
  let surfaceHigh = -Infinity;

  for (const mesh of scene.meshes) {
    if (!mesh.name.startsWith("terrain ") || !mesh.isEnabled()) continue;
    const positions = mesh.getVerticesData("position");
    if (!positions) continue;
    tiles++;

    let low = Infinity;
    let high = -Infinity;
    for (let index = 1; index < positions.length; index += 3) {
      if (positions[index] < low) low = positions[index];
      if (positions[index] > high) high = positions[index];
    }
    low += mesh.position.y;
    high += mesh.position.y;
    surfaceLow = Math.min(surfaceLow, low);
    surfaceHigh = Math.max(surfaceHigh, high);

    const box = mesh.getBoundingInfo().boundingBox;
    const error = Math.max(
      Math.abs(box.minimumWorld.y - low),
      Math.abs(box.maximumWorld.y - high),
    );
    worstBoundsErrorUnits = Math.max(worstBoundsErrorUnits, error);
    if (error < 0.5) boundsMatchSurface++;

    if (active.has(mesh.uniqueId)) visible++;

    // The bounds CreateGround hands out before the vertices are displaced:
    // the same footprint, flattened onto y = 0.
    const centre = box.centerWorld.clone();
    centre.y = 0;
    const half = box.extendSizeWorld;
    const flatRadius = Math.hypot(half.x, half.z);
    if (sphereInFrustum(centre, flatRadius)) visibleWithFlatBounds++;
  }

  return {
    camera: {
      x: Math.round(camera.position.x),
      y: Math.round(camera.position.y),
      z: Math.round(camera.position.z),
    },
    tiles,
    boundsMatchSurface,
    worstBoundsErrorUnits: Number(worstBoundsErrorUnits.toFixed(2)),
    surfaceYRange: [Number(surfaceLow.toFixed(1)), Number(surfaceHigh.toFixed(1))],
    visible,
    visibleWithFlatBounds,
  };
})()`);

let report;
for (let elapsed = 0; elapsed < 180; elapsed += 5) {
  await sleep(5000);
  report = await inspect();
  console.log(`fill ${elapsed + 5}s: tiles=${report.tiles} visible=${report.visible} boundsOk=${report.boundsMatchSurface}`);
  if (report.tiles >= 60) break;
}

// Look out across the range from the summit: the view where a tile whose
// bounds sit at sea level drops out even though its surface fills the screen.
// Switching location leaves the fly camera at its previous altitude, which at
// Gaustatoppen is underground, so lift it onto the peak first.
await evaluate(`(() => {
  const scene = window.__earthScene;
  let summit = -Infinity;
  for (const mesh of scene.meshes) {
    if (!mesh.name.startsWith("terrain ") || !mesh.isEnabled()) continue;
    const positions = mesh.getVerticesData("position");
    if (!positions) continue;
    for (let index = 1; index < positions.length; index += 3) {
      summit = Math.max(summit, positions[index] + mesh.position.y);
    }
  }
  const camera = scene.activeCamera;
  camera.position.set(0, summit + 1, 0);
  camera.rotation.x = 0.45;
  camera.rotation.y = 0.8;
  return summit;
})()`);
await sleep(3000);
const horizon = await inspect();
await screenshot(process.env.EARTH_SHOT ?? "mountain-horizon");

console.log("");
console.log("camera:", JSON.stringify(horizon.camera));
console.log(`terrain surfaces span y = ${horizon.surfaceYRange[0]} .. ${horizon.surfaceYRange[1]} scene units`);
console.log(`tiles enabled: ${horizon.tiles}`);
console.log(`bounds enclosing their surface: ${horizon.boundsMatchSurface}/${horizon.tiles} (worst error ${horizon.worstBoundsErrorUnits} units)`);
console.log(`tiles drawn this frame: ${horizon.visible}`);
console.log(`tiles that would pass the frustum test with flat y=0 bounds: ${horizon.visibleWithFlatBounds}`);

const errors = consoleLogs.filter((line) => line.startsWith("[error]") || line.startsWith("[exception]"));
console.log(`errors: ${errors.length}`);
errors.slice(0, 10).forEach((line) => console.log(line));

writeFileSync(`${OUT_DIR}/console.log`, consoleLogs.join("\n"));
console.log("done");
socket.close();
chrome.kill();
