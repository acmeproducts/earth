import { parentPort } from "node:worker_threads";
import "../register-typescript.mjs";

globalThis.self = { postMessage: (message) => parentPort.postMessage(message), onmessage: null };
await import("../../src/water/LakeCollection.worker.ts");
parentPort.on("message", (data) => self.onmessage({ data }));
