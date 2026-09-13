// Manual verification driver (not part of the test suite): frames a procedural
// tree's crown in the impostor demo from the side, from a raised angle and from
// above, so the shape of the canopy can be judged rather than the whole tree.
// Run with: node tests/drive-crown-shot.mjs [species] [crownHeight] [radius]
import { launchBrowser, sleep } from "./browser-harness.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9343;
const APP_URL = "http://localhost:3000/";
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-crown";
const SPECIES = process.argv[2] ?? "palm";
const CROWN_HEIGHT = Number(process.argv[3] ?? "1.25");
const RADIUS = Number(process.argv[4] ?? "2.8");
// Extra demo query such as CROWN_QUERY="&season=autumn&maturity=1"; also suffixes the file names.
const EXTRA_QUERY = process.env.CROWN_QUERY ?? "";
const SUFFIX = EXTRA_QUERY.replace(/[^a-z0-9]+/gi, "-").replace(/-$/, "");

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

async function screenshot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT_DIR}/${name}.png`, Buffer.from(data, "base64"));
  console.log(`saved ${name}.png`);
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
await send("Page.navigate", { url: `${APP_URL}?tree-impostor=${SPECIES}${EXTRA_QUERY}` });
console.log("demo loaded:", await waitForLoad(120));
await sleep(2500);

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

const pose = async (alpha, beta) => evaluate(`(() => {
  const camera = window.__earthScene.activeCamera;
  camera.target.set(0, ${CROWN_HEIGHT}, 0);
  camera.radius = ${RADIUS};
  camera.alpha = ${alpha};
  camera.beta = ${beta};
  return [camera.alpha, camera.beta, camera.radius];
})()`);

await pose(-Math.PI / 2, Math.PI / 2);
await sleep(800);
await screenshot(`${SPECIES}${SUFFIX}-crown-side`);
await pose(-Math.PI / 2 + 1.1, Math.PI / 2.6);
await sleep(800);
await screenshot(`${SPECIES}${SUFFIX}-crown-raised`);
await pose(-Math.PI / 2, 0.25);
await sleep(800);
await screenshot(`${SPECIES}${SUFFIX}-crown-top`);

console.log("done");
socket.close();
chrome.kill();
