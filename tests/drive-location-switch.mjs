// Manual repro/verification driver (not part of the test suite): drives the
// dev server at localhost:3000 in headless Chrome, presses "2" to switch the
// example location, and screenshots the scene to confirm vegetation survives
// the terrain rebuild. Run with: node tests/drive-location-switch.mjs
import { launchBrowser, sleep } from "./browser-harness.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEBUG_PORT = 9337;
const APP_URL = "http://localhost:3000/";
const OUT_DIR = "C:/Users/TobiasElinder/AppData/Local/Temp/earth-repro-loc";

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

async function mouse(type, x, y, buttons) {
  await send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    buttons,
    clickCount: type === "mousePressed" ? 1 : 0,
    pointerType: "mouse",
  });
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: APP_URL });

for (let attempt = 0; attempt < 240; attempt++) {
  if (await evaluate("!document.getElementById('loading')")) break;
  await sleep(1000);
}
console.log("app initialized");
await evaluate("document.getElementById('renderCanvas').focus()");
await sleep(3000);

await screenshot("loc1-initial");

// Switch to example location 2 via the coordinate form.
const logCountBefore = consoleLogs.length;
await key("rawKeyDown", "Escape", "Escape", 27);
await key("keyUp", "Escape", "Escape", 27);
await evaluate(`
  document.querySelector('[aria-label="Latitude"]').value = '59.8888085995981';
  document.querySelector('[aria-label="Longitude"]').value = '10.593090176648504';
  document.querySelector('.coordinate-form').requestSubmit();
`);

// The rebuild logs its final layer counts; wait for the OSM line.
for (let attempt = 0; attempt < 180; attempt++) {
  const newLogs = consoleLogs.slice(logCountBefore);
  if (newLogs.some((line) => line.includes("OSM:"))) break;
  await sleep(1000);
}
await sleep(4000);
await screenshot("loc2-after-switch");

// Then a couple of movement taps at the new location.
for (let tap = 1; tap <= 3; tap++) {
  await key("rawKeyDown", "w", "KeyW", 87);
  await sleep(150);
  await key("keyUp", "w", "KeyW", 87);
  await sleep(500);
  await screenshot(`loc2-move${tap}`);
}

writeFileSync(`${OUT_DIR}/console.log`, consoleLogs.join("\n"));
console.log("done");
socket.close();
chrome.kill();
