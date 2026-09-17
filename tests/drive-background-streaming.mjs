// Run against yarn dev. --throttle accelerates Chrome's long-hidden timer policy.
import { launchBrowser, sleep } from "./browser-harness.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const profile = mkdtempSync(join(tmpdir(), "earth-background-"));
const { chrome, socket, send, evaluate } = await launchBrowser([
  "--remote-debugging-port=9349", `--user-data-dir=${profile}`,
  "--headless=new", "--window-size=1000,750", "--no-first-run", "about:blank",
  ...(process.argv.includes("--throttle") ? ["--enable-features=IntensiveWakeUpThrottling:grace_period_seconds/10,OptOutZeroTimeoutTimersFromThrottling,AllowAggressiveThrottlingWithWebSocket"] : []),
]);
try {
  await send("Runtime.enable");
  await send("Page.enable");
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") console.log("ERROR", message.params.exceptionDetails);
  });
  await send("Page.navigate", { url: "http://localhost:3000/" });
  let before;
  let after;
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    const result = await evaluate(`(() => {
      const chunkKey = Object.keys(window).find(key => key.startsWith('webpackChunk'));
      if (!chunkKey) return null;
      let req;
      window[chunkKey].push([['background-probe-' + Date.now()], {}, r => { req = r; }]);
      const exports = Object.values(req.c).map(module => module.exports).filter(Boolean);
      const Game = exports.find(value => value.Game)?.Game;
      if (Game && !Game.prototype.backgroundProbeInstalled) {
        const run = Game.prototype.run;
        Game.prototype.run = function() { window.backgroundGame = this; return run.call(this); };
        Game.prototype.backgroundProbeInstalled = true;
      }
      const game = window.backgroundGame;
      const diagnostics = exports.find(value => value.streamingDiagnosticsSnapshot)?.streamingDiagnosticsSnapshot();
      return { hidden: document.hidden, loading: document.querySelector('.loader-text')?.textContent,
        tiles: game?.tiles.size,
        details: game ? [...game.tiles.values()].filter(tile => tile.detailed).length : undefined,
        builds: game?.activeTileBuilds.size,
        radius: game?.terrainTileRadius,
        frameAge: game ? Math.round(performance.now() - game.lastFrameStartMilliseconds) : undefined,
        active: diagnostics?.activeStages.map(({label, stage, durationMilliseconds}) => ({label, stage, seconds: Math.round(durationMilliseconds / 1000)})) };
    })()`);
    if (i % 5 === 0) console.log(JSON.stringify(result));
    if (result && !result.loading && !globalThis.backgrounded) {
      before = result;
      await send("Target.createTarget", { url: "about:blank" });
      globalThis.backgrounded = true;
      console.log("Switched to another tab");
    }
    if (result?.hidden && result.tiles !== undefined) {
      after = result;
      if (result.tiles >= (2 * result.radius + 1) ** 2 && result.builds === 0) break;
      if (result.frameAge >= 90000 && result.tiles >= 25 && result.details > before.details) break;
    }
  }
  console.log("RESULT", JSON.stringify({ before, after }));
  assert.ok(after?.hidden, "the app must really be hidden");
  assert.ok(after.frameAge > 1000, "rendering must have stopped");
  assert.ok(after.tiles > before.tiles, "new terrain must load while hidden");
  assert.ok(after.details > before.details, "detailed tiles must finish while hidden");
  assert.ok(after.tiles >= 25, "background progress must extend beyond the immediate detail window");
} finally {
  socket.close();
  chrome.kill();
}
