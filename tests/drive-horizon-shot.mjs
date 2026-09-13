// Manual verification helper: loads the app, lifts the camera, points it at
// the horizon, waits for the streamed radius to fill, and screenshots it.
// Run with: node tests/drive-horizon-shot.mjs
import { launchBrowser, sleep } from "./browser-harness.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9339;
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-stream";

mkdirSync(OUT_DIR, { recursive: true });
const { chrome, socket, send, evaluate } = await launchBrowser([
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${OUT_DIR}/profile-horizon`,
  "--headless=new",
  "--window-size=1600,900",
  "--enable-unsafe-swiftshader",
  "--no-first-run",
  "about:blank",
], CHROME);

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
