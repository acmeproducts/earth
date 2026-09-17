// Manual driver: close-ups of the far grass edge against trees, to check the
// distance thinning keeps grass opaque and off the trunks.
// Run while the dev server is active: node tests/drive-grass-fade-shot.mjs
import { launchBrowser, sleep } from "./browser-harness.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const DEBUG_PORT = 9351;
const APP_URL = "http://localhost:3000/?clock=manual&date=2026-09-16&time=14&wind-speed=0&clouds=off";
const OUT_DIR = process.env.OUT_DIR ?? "C:/tmp/earth-grass";
mkdirSync(OUT_DIR, { recursive: true });

const args = [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${OUT_DIR}/profile`,
  "--headless=new",
  "--window-size=1600,900",
  "--no-first-run",
  "about:blank",
];
if (process.env.EARTH_CHROME_GPU !== "hardware") args.splice(-2, 0, "--enable-unsafe-swiftshader");
const { chrome, send, evaluate } = await launchBrowser(args);

async function screenshot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT_DIR}/${name}.png`, Buffer.from(data, "base64"));
  console.log(`saved ${name}.png`);
}

try {
  await send("Runtime.enable");
  await send("Page.enable");
  const errors = [];
  send("Log.enable");
  await send("Page.navigate", { url: APP_URL });
  for (let attempt = 0; attempt < 300; attempt++) {
    const hidden = await evaluate("(() => { const l = document.getElementById('loading'); return !l || l.classList.contains('hidden') || l.style.display === 'none'; })()");
    if (hidden) break;
    await sleep(1000);
  }
  await sleep(8000);
  await evaluate(`(() => {
    const chunkKey = Object.keys(window).find((key) => key.startsWith("webpackChunk"));
    let req;
    window[chunkKey].push([["earth-probe"], {}, (r) => { req = r; }]);
    for (const id of Object.keys(req.c)) {
      const e = req.c[id]?.exports;
      if (e && e.EngineStore) { window.__scene = e.EngineStore.LastCreatedScene; return true; }
    }
    throw new Error("EngineStore not found");
  })()`);
  console.log(JSON.stringify(await evaluate(`(() => {
    const s = window.__scene;
    const g = s.meshes.find((m) => /grassImpostors/i.test(m.name) && m.thinInstanceCount > 1000);
    const model = s.meshes.find((m) => m.name === "grassModels" && m.thinInstanceCount > 0);
    const f = g.material._floats, mf = model?.material?._floats;
    return { blend: g.material.options.needAlphaBlending, near: f.distanceFadeNear, far: f.distanceFadeFar, modelNear: mf?.distanceFadeNear, modelFar: mf?.distanceFadeFar, ready: g.material.isReady(g) && (!model || model.material.isReady(model)) };
  })()`)));
  const pose = (yaw, pitch, fov) => evaluate(`(() => { const c = window.__scene.activeCamera; c.rotation.set(${pitch}, ${yaw}, 0); c.fov = ${fov}; return true; })()`);
  await sleep(1500);
  const views = [["spruce", 0.188, -0.004, 0.1], ["birch", 0.367, -0.004, 0.1], ["north", 0.15, -0.03, 0.3], ["forestL", -Math.PI / 2 - 0.35, -0.01, 0.35], ["wide", 0, -0.02, 0.8]];
  for (const [name, yaw, pitch, fov] of views) {
    await pose(yaw, pitch, fov);
    await sleep(1200);
    await screenshot(`dropout-${name}`);
  }
} finally {
  chrome.kill();
}
