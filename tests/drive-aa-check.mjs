// Manual runtime smoke check against the development server on port 3000.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profile = mkdtempSync(join(tmpdir(), "earth-aa-"));
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--remote-debugging-port=9357", `--user-data-dir=${profile}`,
  "--no-first-run", "--window-size=1000,700", "about:blank",
], { stdio: "ignore", windowsHide: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
try {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      target = (await (await fetch("http://127.0.0.1:9357/json")).json())
        .find((entry) => entry.type === "page");
    } catch { /* Browser is starting. */ }
    if (!target) await pause(250);
  }
  if (!target) throw new Error("Chrome did not start");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => { socket.onopen = resolve; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    if (message.id) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    pending.set(current, (message) => message.error ? reject(message.error) : resolve(message.result));
    socket.send(JSON.stringify({ id: current, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send("Runtime.enable");
  const reflectionsOff = process.argv.includes("--no-reflections");
  await send("Page.navigate", { url: `http://localhost:3000/${reflectionsOff ? '?reflections=off' : ''}` });
  for (const [index, mode] of ["msaa", "fxaa", "taa", "off", "taa", "msaa"].entries()) {
    if (index > 0) {
      await evaluate(`(() => {
        const select = document.querySelector('select[aria-label="Antialiasing"]');
        select.value = ${JSON.stringify(mode)};
        select.dispatchEvent(new Event('change', {bubbles:true}));
      })()`);
      await pause(1500);
    }
    let state;
    for (let attempt = 0; attempt < 90; attempt++) {
      await pause(1000);
      state = await evaluate(`(() => {
        const key = Object.keys(window).find(k => k.startsWith('webpackChunk'));
        if (!key) return null;
        let req;
        window[key].push([['aa-check-' + Date.now()], {}, r => { req = r; }]);
        const store = Object.values(req.c).find(m => m.exports?.EngineStore)?.exports.EngineStore;
        const scene = store?.LastCreatedScene;
        if (!scene?.activeCamera || document.getElementById('loading')) return null;
        return { passes: scene.activeCamera._postProcesses.filter(Boolean).map(p => ({name:p.name,samples:p.samples})),
          selection: document.querySelector('select[aria-label="Antialiasing"]')?.value,
          saved: localStorage.getItem('earth.antialiasing.v1'),
          frame: scene.getFrameId() };
      })()`);
      if (state && state.frame > 10) break;
    }
    if (!state) throw new Error(`${mode}: scene did not load`);
    await pause(2000);
    console.log(mode, JSON.stringify(state));
    if (state.selection !== mode || (index > 0 && state.saved !== mode)) {
      throw new Error(`${mode}: selection or persistence mismatch`);
    }
    if (state.passes.some(p => p.name === "TAA") !== (mode === "taa")) {
      throw new Error(`${mode}: unexpected TAA attachment`);
    }
    if (mode !== "msaa" && state.passes.some(p => p.samples > 1)) {
      throw new Error(`${mode}: still has a multisampled postprocess`);
    }
    if (state.passes.some(p => p.name === "FXAA") !== (mode === "fxaa")) {
      throw new Error(`${mode}: unexpected FXAA attachment`);
    }
    const expected = (reflectionsOff ? 0 : 1) + (mode === "taa" ? 2 : mode === "fxaa" || (mode === "msaa" && reflectionsOff) ? 1 : 0);
    if (state.passes.length !== expected) {
      throw new Error(`${mode}: unexpected pass count`);
    }
  }
  if (errors.length) throw new Error(JSON.stringify(errors));
  console.log("All AA modes switched live without uncaught runtime exceptions.");
} finally {
  socket?.close();
  chrome.kill();
}
