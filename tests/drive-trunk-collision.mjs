// Manual verification driver (not part of the test suite): drives the dev
// server at localhost:3000 in headless Chrome, switches to walker mode, drops
// the walker onto the nearest tree's stem axis and then walks straight at the
// tree, checking that trunk collision pushes the body out and keeps it out.
// Run with: node tests/drive-trunk-collision.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = Number(process.env.TRUNK_DEBUG_PORT ?? 9341);
const APP_URL = `http://localhost:${process.env.TRUNK_PORT ?? 3000}/?date=2026-07-01&time=13`;
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-trunk";
const PLAYER_RADIUS_METERS = 0.3;

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

async function key(type, keyName, code, virtualKeyCode) {
  await send("Input.dispatchKeyEvent", {
    type,
    key: keyName,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
    text: type === "keyDown" ? keyName : undefined,
  });
}

async function press(keyName, code, virtualKeyCode) {
  await key("keyDown", keyName, code, virtualKeyCode);
  await sleep(50);
  await key("keyUp", keyName, code, virtualKeyCode);
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

// Nearby trees render as procedural models (thin-instanced "cachedTreePart"
// meshes) under the tile's treeField root. Impostor meshes are skipped: LOD
// repacking rewrites their buffers and Babylon caches the first matrix read,
// so their reported instances can be stale. Fallen logs are skipped by name.
const nearestTree = async () => evaluate(`(() => {
  const scene = window.__earthScene;
  const camera = scene.activeCamera;
  const isTreeFieldMesh = (mesh) => {
    let node = mesh;
    while (node.parent) node = node.parent;
    return node.name === "treeField" && node.isEnabled();
  };
  let best;
  for (const mesh of scene.meshes) {
    if (!(mesh.thinInstanceCount > 0) || /log/i.test(mesh.name) || mesh.name.startsWith("treeField-")) continue;
    if (!isTreeFieldMesh(mesh)) continue;
    // Thin-instance matrices are mesh-local; the tile root carries the offset.
    const world = mesh.computeWorldMatrix(true).m;
    const matrices = mesh.thinInstanceGetWorldMatrices();
    for (let index = 0; index < Math.min(matrices.length, mesh.thinInstanceCount); index++) {
      const matrix = matrices[index];
      const x = matrix.m[12] + world[12], y = matrix.m[13] + world[13], z = matrix.m[14] + world[14];
      const distance = Math.hypot(x - camera.position.x, z - camera.position.z);
      if (!best || distance < best.distance) best = { x, y, z, distance, mesh: mesh.name };
    }
  }
  return best ?? null;
})()`);

let tree = null;
for (let elapsed = 0; elapsed < 180 && !tree; elapsed += 3) {
  await sleep(3000);
  tree = await nearestTree();
  console.log(`trees ${elapsed + 3}s: ${tree ? JSON.stringify(tree) : "none yet"}`);
}
if (!tree) throw new Error("no detail tree models appeared near the spawn");

// Walk mode enables camera collisions; the label alone is ambiguous because
// the fly-mode hint also mentions "Walk".
await evaluate(`(() => {
  const canvas = document.getElementById("renderCanvas");
  canvas.tabIndex = 1;
  canvas.focus();
  return document.activeElement === canvas;
})()`);
const inWalkMode = () => evaluate("window.__earthScene.activeCamera.checkCollisions === true");
for (let attempt = 0; attempt < 4 && !(await inWalkMode()); attempt++) {
  if (attempt % 2 === 0) {
    await press("g", "KeyG", 71);
  } else {
    await evaluate(`(() => {
      const canvas = document.getElementById("renderCanvas");
      canvas.focus();
      for (const type of ["keydown", "keyup"]) {
        canvas.dispatchEvent(new KeyboardEvent(type, { key: "g", code: "KeyG", keyCode: 71, bubbles: true }));
      }
      return true;
    })()`);
  }
  await sleep(400);
}
console.log(`movement mode: ${await evaluate("document.getElementById('flySpeed')?.value ?? ''")}`);
if (!(await inWalkMode())) throw new Error("could not switch to walker mode");

const metersPerUnit = await evaluate(`${PLAYER_RADIUS_METERS} / window.__earthScene.activeCamera.ellipsoid.x`);
console.log(`metersPerUnit ≈ ${metersPerUnit.toFixed(2)}`);

const walkerState = async () => evaluate(`(() => {
  const camera = window.__earthScene.activeCamera;
  return { x: camera.position.x, y: camera.position.y, z: camera.position.z };
})()`);
const distanceMeters = (state) => Math.hypot(state.x - tree.x, state.z - tree.z) * metersPerUnit;
const teleport = (x, z, y, yaw) => evaluate(`(() => {
  const camera = window.__earthScene.activeCamera;
  camera.position.set(${x}, ${y}, ${z});
  camera.rotation.set(0.1, ${yaw}, 0);
  return true;
})()`);

// Phase 1: drop the walker onto the stem axis. It must settle at exactly the
// stem radius plus its own body radius.
await teleport(tree.x, tree.z, tree.y + 0.3, 0);
await sleep(3000);
const pushed = await walkerState();
const contactMeters = distanceMeters(pushed);
console.log(`after drop on axis: pushed to ${contactMeters.toFixed(2)} m from stem`);

// Phase 2: stand 4 m west of the tree facing east and hold W for 1.5 s.
// A cylinder deflects a walker rather than stopping it dead, so the check is
// that the body never gets closer than the contact distance while passing.
const startOffset = 4 / metersPerUnit;
await teleport(tree.x - startOffset, tree.z, pushed.y, Math.PI / 2);
await sleep(1200);
const beforeWalk = await walkerState();
let minimumMeters = Infinity;
await key("keyDown", "w", "KeyW", 87);
for (let elapsed = 0; elapsed < 1500; elapsed += 40) {
  await sleep(40);
  minimumMeters = Math.min(minimumMeters, distanceMeters(await walkerState()));
}
await key("keyUp", "w", "KeyW", 87);
await sleep(200);
const afterWalk = await walkerState();
const walkedMeters = Math.hypot(afterWalk.x - beforeWalk.x, afterWalk.z - beforeWalk.z) * metersPerUnit;
const deflectedMeters = Math.abs(afterWalk.z - beforeWalk.z) * metersPerUnit;
console.log(`walk at stem: closest approach ${minimumMeters.toFixed(2)} m, travelled ${walkedMeters.toFixed(2)} m, deflected ${deflectedMeters.toFixed(2)} m sideways`);

// Frame the stem from the blocked side for the screenshot.
await teleport(tree.x - startOffset / 2, tree.z, pushed.y, Math.PI / 2);
await sleep(800);
await screenshot("trunk-ahead");

// Phase 3: control walk in open space keeps full speed.
await teleport(tree.x - startOffset, tree.z, pushed.y, 0);
await sleep(800);
const beforeFree = await walkerState();
await key("keyDown", "w", "KeyW", 87);
await sleep(600);
await key("keyUp", "w", "KeyW", 87);
await sleep(200);
const afterFree = await walkerState();
const freeMeters = Math.hypot(afterFree.x - beforeFree.x, afterFree.z - beforeFree.z) * metersPerUnit;
console.log(`control walk (north, 0.6 s): ${freeMeters.toFixed(2)} m`);

const errors = consoleLogs.filter((line) => line.startsWith("[error]") || line.startsWith("[exception]"));
console.log(`errors: ${errors.length}`);
errors.slice(0, 10).forEach((line) => console.log(line));

const ok = contactMeters > PLAYER_RADIUS_METERS && contactMeters < 3
  && minimumMeters > contactMeters - 0.15
  && (walkedMeters < 12 || deflectedMeters > 0.3);
console.log(ok ? "RESULT: trunk collision works" : "RESULT: trunk collision FAILED");

writeFileSync(`${OUT_DIR}/console.log`, consoleLogs.join("\n"));
socket.close();
chrome.kill();
process.exit(ok ? 0 : 1);
