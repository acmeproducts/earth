import { spawn } from "node:child_process";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Launches an isolated diagnostic browser; callers close socket and chrome in finally. */
export async function launchBrowser(args, executable = "C:/Program Files/Google/Chrome/Application/chrome.exe") {
  const port = args.find((arg) => arg.startsWith("--remote-debugging-port="))?.split("=")[1];
  if (!port) throw new Error("A remote debugging port is required");
  const chrome = spawn(executable, args, { stdio: "ignore", windowsHide: true });
  let launchError;
  chrome.on("error", (error) => { launchError = error; });
  let socket;
  try {
    let target;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (launchError) throw launchError;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json`, {
          signal: AbortSignal.timeout(1000),
        });
        target = (await response.json()).find((entry) => entry.type === "page");
      } catch { /* The browser may still be starting. */ }
      if (target) break;
      await sleep(200);
    }
    if (!target) throw launchError ?? new Error("Chrome debug endpoint never came up");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const request of pending.values()) request.reject(new Error("Browser connection closed"));
      pending.clear();
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) return reject(new Error("Browser connection closed"));
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    return { chrome, socket, send, evaluate };
  } catch (error) {
    socket?.close();
    chrome.kill();
    throw error;
  }
}
