import { parentPort } from "node:worker_threads";
import "../register-typescript.mjs";

// Adapt the browser worker entry to a real Node worker for transport tests.
globalThis.self = { postMessage: (message) => parentPort.postMessage(message), onmessage: null };
await import("../../src/roads/RoadPlanning.worker.ts");
parentPort.on("message", (data) => self.onmessage({ data }));
