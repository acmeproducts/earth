// Manual localhost reproduction: Oslo text search, then isolate water layers.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const output = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-oslo-water";
mkdirSync(output, { recursive: true });
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--remote-debugging-port=9363", `--user-data-dir=${output}/profile`,
  "--headless=new", "--window-size=1280,900", "--enable-unsafe-swiftshader",
  "--no-first-run", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  try { target = (await (await fetch("http://127.0.0.1:9363/json")).json()).find((t) => t.type === "page"); } catch {}
  if (!target) await sleep(200);
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { socket.onopen = r; });
let id = 0;
const pending = new Map();
socket.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = msg.params.args.map((a) => a.value ?? a.description).join(" ");
    if (/coordinates|Error|failed|World frame/i.test(text)) console.log(text.slice(0,500));
  }
};
const send = (method, params = {}) => new Promise((r) => {
  pending.set(++id,r); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const msg = await send("Runtime.evaluate", { expression, returnByValue:true, awaitPromise:true });
  if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails));
  return msg.result?.result?.value;
};
const shot = async (name) => {
  const msg = await send("Page.captureScreenshot", { format:"png" });
  writeFileSync(`${output}/${name}.png`, Buffer.from(msg.result.data, "base64"));
  console.log(`Screenshot: ${output}/${name}.png`);
};
await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate", { url:"http://localhost:3000/" });
for (let i=0;i<240;i++) {
  if (await evaluate("!!document.querySelector('.place-form')")) break;
  if(i%20===0) console.log("Waiting for initial scene",i);
  await sleep(1000);
}
if (!process.argv.includes('--resume')) {
  console.log(await evaluate(`(() => { const input=document.querySelector('.place-form input'); input.value='Oslo'; input.form.requestSubmit(); return 'Submitted Oslo search'; })()`));
  await sleep(15000);
}
for (let i=0;i<240;i++) {
  if(await evaluate("!!document.querySelector('.place-form') && !document.getElementById('loading')")) break;
  if(i%20===0) console.log("Waiting for Oslo",i);
  await sleep(1000);
}
console.log(await evaluate(`(() => {
  let req;window[Object.keys(window).find(k=>k.startsWith('webpackChunk'))].push([['oslo-probe'],{},r=>req=r]);
  window.__osloScene=Object.values(req.c).map(m=>m.exports?.EngineStore?.LastCreatedScene).find(Boolean);
  return document.querySelector('.coordinate-form')?.innerText;
})()`));
await sleep(45000);
await evaluate(`(() => {const s=window.__osloScene;s.activeCamera.position.set(0,25,0);s.activeCamera.rotation.set(Math.PI/2,0,0);const slider=document.querySelector('input[aria-label="Time of day"]');if(slider){slider.value='12';slider.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
await sleep(2000);
await shot("oslo-original");
console.log(await evaluate(`(() => { const s=window.__osloScene; return {camera:s.activeCamera.position.asArray(),rotation:s.activeCamera.rotation.asArray(),water:s.meshes.filter(m=>/water|lake/i.test(m.name)).map(m=>({name:m.name,position:m.getAbsolutePosition().asArray(),vertices:m.getTotalVertices()}))};})()`));
for (const kind of ["waterMesh","terrainLake","waterways","shoreline"]) {
  await evaluate(`window.__osloScene.meshes.filter(m=>m.name.includes(${JSON.stringify(kind)})).forEach(m=>m.setEnabled(false))`);
  await sleep(2500); await shot(`without-${kind}`);
  await evaluate(`window.__osloScene.meshes.filter(m=>m.name.includes(${JSON.stringify(kind)})).forEach(m=>m.setEnabled(true))`);
}
if (process.argv.includes('--hold')) {
  console.log('Ready for inspection on port 9363');
  await new Promise(r=>process.once('SIGINT',r));
}
socket.close(); chrome.kill();
