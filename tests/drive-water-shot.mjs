// Manual verification helper: loads the app, lifts the camera over the coast,
// and screenshots the sea from several headings so the water surface can be
// compared with and without reflections.
// Run with: node tests/drive-water-shot.mjs [--no-reflections]
import { launchBrowser, sleep } from "./browser-harness.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9341;
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-stream";
const reflectionsOff = process.argv.includes("--no-reflections");
const debugRays = process.argv.includes("--debug");
const tuneIndex = process.argv.indexOf("--tune");
const tuning = tuneIndex === -1 ? null : process.argv[tuneIndex + 1];
const labelIndex = process.argv.indexOf("--label");
const suffix = labelIndex !== -1
  ? process.argv[labelIndex + 1]
  : reflectionsOff ? "off" : debugRays ? "debug" : "on";
const url = `http://localhost:3000/${reflectionsOff ? "?reflections=off" : ""}`;

mkdirSync(OUT_DIR, { recursive: true });
const { chrome, socket, send, evaluate } = await launchBrowser([
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${OUT_DIR}/profile-water-${suffix}`,
  "--headless=new",
  "--window-size=1600,900",
  "--enable-unsafe-swiftshader",
  "--no-first-run",
  "about:blank",
], CHROME);

await send("Runtime.enable");
await send("Page.enable");
const consoleLines = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.consoleAPICalled") {
    consoleLines.push(message.params.args.map((a) => a.value ?? a.description).join(" "));
  }
};
await send("Page.navigate", { url });
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

// Pin the sun so both runs are lit identically, whatever the wall clock says.
console.log(await evaluate(`(() => {
  const slider = document.querySelector('#sceneControls input[type="range"][aria-label="Time of day"]');
  if (!slider) return "no time slider";
  slider.value = "17";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  return "sun pinned to 17:00";
})()`));

// Give the streamed radius time to fill.
for (let elapsed = 0; elapsed < 150; elapsed += 5) {
  await sleep(5000);
  const tiles = await evaluate(
    `window.__earthScene.meshes.filter((mesh) => mesh.name.startsWith("terrain ")).length`,
  );
  if (tiles >= 289) break;
  if (elapsed % 20 === 0) console.log(`${elapsed + 5}s: tiles=${tiles}`);
}

console.log(await evaluate(`(() => {
  const scene = window.__earthScene;
  const water = scene.meshes.find((mesh) => mesh.name === "waterMesh");
  return JSON.stringify({
    water: !!water,
    material: water?.material?.getClassName(),
    ready: water?.material?.isReady(water),
    reflection: !!water?.material?.reflectionTexture,
    prepass: !!scene.prePassRenderer,
    prepassEnabled: scene.prePassRenderer?.enabled,
  });
})()`));

if (tuning) {
  console.log(await evaluate(`(() => {
    const pipeline = window.__earthScene.postProcessRenderPipelineManager.supportedPipelines
      .find((p) => (p._name ?? p.name) === "waterReflections");
    if (!pipeline) return "no pipeline";
    Object.assign(pipeline, ${tuning});
    return "tuned " + JSON.stringify(${tuning});
  })()`));
  await sleep(2000);
}

if (debugRays) {
  // Colour the surface by what each traced ray ran into: green hit something,
  // yellow left the screen, blue ran out of distance, red ran out of steps.
  console.log(await evaluate(`(() => {
    const pipeline = window.__earthScene.postProcessRenderPipelineManager.supportedPipelines
      .find((p) => (p._name ?? p.name) === "waterReflections");
    if (!pipeline) return "no pipeline";
    // Without blur the shader leaves non-reflective pixels showing the scene,
    // so anything painted flat is a pixel SSR actually traced.
    pipeline.blurDispersionStrength = 0;
    pipeline.debug = true;
    return "debug on";
  })()`));
  await sleep(2000);
}

// One shot from above for the whole seascape, and one from just over the
// surface where a reflection of the far shore would actually be visible.
for (const [name, x, y, z, pitch, rotation] of [
  ["high-east", 0, 6, 0, 0.12, Math.PI / 2],
  // Stand out on the water and look back at the wooded shore, which is where
  // a reflection has something to show.
  ["off-east", 30, 0.6, 0, 0.04, -Math.PI / 2],
  ["off-south", 0, 0.6, -30, 0.04, 0],
  ["off-north", 0, 0.6, 30, 0.04, Math.PI],
]) {
  await evaluate(`(() => {
    const camera = window.__earthScene.activeCamera;
    camera.position.set(${x}, ${y}, ${z});
    camera.rotation.set(${pitch}, ${rotation}, 0);
    return true;
  })()`);
  await sleep(2500);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT_DIR}/water-${suffix}-${name}.png`, Buffer.from(data, "base64"));
}

// Frame cost at a fixed viewpoint, for comparing runs with and without the
// reflection pass. Software rasterisation exaggerates full-screen passes, so
// treat this as a relative signal only.
await evaluate(`(() => {
  const camera = window.__earthScene.activeCamera;
  camera.position.set(30, 0.6, 0);
  camera.rotation.set(0.04, -Math.PI / 2, 0);
  return true;
})()`);
await sleep(3000);
// The render loop is capped by requestAnimationFrame, so drive frames directly.
console.log(await evaluate(`(() => {
  const scene = window.__earthScene;
  for (let warmUp = 0; warmUp < 5; warmUp++) scene.render();
  const samples = [];
  for (let frame = 0; frame < 40; frame++) {
    const start = performance.now();
    scene.render();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const at = (q) => samples[Math.floor(samples.length * q)].toFixed(1);
  return "uncapped frame ms: median " + at(0.5) + ", p90 " + at(0.9);
})()`));

if (process.argv.includes("--switch")) {
  // Rebuilding the world tears the water plane down; the sky reflection it
  // borrows has to survive that.
  await evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    document.querySelector("canvas").dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    return true;
  })()`);
  await sleep(45000);
  console.log(await evaluate(`(() => {
    const scene = window.__earthScene;
    const water = scene.meshes.find((m) => m.name === "waterMesh");
    const sky = scene.textures.find((t) => t.name === "skyProbe");
    return "after location switch: water=" + !!water
      + " reflection=" + !!water?.material?.reflectionTexture
      + " reflectionUsable=" + (water?.material?.reflectionTexture?.isReady() ?? null)
      + " probeAlive=" + !!sky;
  })()`));
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT_DIR}/water-${suffix}-switched.png`, Buffer.from(shot.data, "base64"));
}

const errors = consoleLines.filter((line) => /error|warn|lost|fail/i.test(line ?? ""));
if (errors.length) console.log("console:", errors.slice(0, 20).join("\n"));
console.log("done", suffix);
socket.close();
chrome.kill();
