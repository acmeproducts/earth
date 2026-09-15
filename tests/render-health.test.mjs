import assert from "node:assert/strict";
import test from "node:test";
import { Mesh, NullEngine, RawTexture, Scene, ShaderMaterial } from "@babylonjs/core";
import { monitorRenderHealth } from "../src/diagnostics/RenderHealth.ts";

test("reports shared texture destruction but ignores normal owner cleanup", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const reports = [];
  monitorRenderHealth(scene, (...args) => reports.push(args));
  try {
    const texture = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
    texture.name = "shared atlas";
    const material = new ShaderMaterial("vegetation", scene, "unused", {});
    material.setTexture("atlas", texture);
    const mesh = new Mesh("surviving tree", scene);
    mesh.material = material;
    texture.dispose();
    await Promise.resolve();
    assert.equal(reports.length, 1);
    assert.match(reports[0][0], /shared atlas.*surviving tree/);
    assert.ok(reports[0][1] instanceof Error);

    reports.length = 0;
    const owned = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
    material.setTexture("atlas", owned);
    mesh.dispose(false, true);
    await Promise.resolve();
    assert.equal(reports.length, 0);
  } finally { scene.dispose(); engine.dispose(); }
});

test("reports GPU loss/restoration and detaches when the scene is disposed", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const reports = [];
  monitorRenderHealth(scene, (message) => reports.push(message));
  engine.onContextLostObservable.notifyObservers(engine);
  engine.onContextRestoredObservable.notifyObservers(engine);
  assert.equal(reports.length, 2);
  scene.dispose();
  engine.onContextLostObservable.notifyObservers(engine);
  assert.equal(reports.length, 2);
  engine.dispose();
});
