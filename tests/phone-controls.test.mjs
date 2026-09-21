import assert from "node:assert/strict";
import test from "node:test";
import { isPhone } from "../src/core/Device.ts";
import { TouchControls } from "../src/app/TouchControls.ts";
import { createImpostorAssetProvider } from "../src/rendering/Impostor.ts";

test("phone sampling is 3x3 at 64px, desktop keeps its quality, and URL overrides survive", () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalWindow = globalThis.window;
  try {
    globalThis.window = { location: { search: "" }, matchMedia: () => ({ matches: false }) };
    const provider = createImpostorAssetProvider({ name: "test", sampling: {
      horizontalSamples: { default: 5, minimum: 1, maximum: 16 },
      verticalSamples: { default: 5, minimum: 1, maximum: 16 },
      resolution: { default: 128, minimum: 16, maximum: 512 },
    } });
    for (const userAgent of ["iPhone", "Mozilla Android Mobile"]) {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent } });
      assert.equal(isPhone(), true);
      assert.deepEqual(provider.getDefaultSampling(), { horizontalSamples: 3, verticalSamples: 3, resolution: 64 });
      for (const [minimum, defaultResolution, expected] of [[96, 192, 96], [16, 32, 32]]) {
        const constrained = createImpostorAssetProvider({ name: "constrained", sampling: {
          horizontalSamples: { default: 5, minimum: 1, maximum: 16 },
          verticalSamples: { default: 5, minimum: 1, maximum: 16 },
          resolution: { default: defaultResolution, minimum, maximum: 512 },
        } });
        assert.equal(constrained.getDefaultSampling().resolution, expected);
      }
    }
    window.location.search = "?test-x-samples=7&test-resolution=192";
    assert.equal(provider.getDefaultSampling().horizontalSamples, 7);
    assert.equal(provider.getDefaultSampling().resolution, 192);
    window.location.search = "";
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Windows" } });
    assert.equal(provider.getDefaultSampling().horizontalSamples, 5);
    assert.equal(provider.getDefaultSampling().resolution, 128);
    window.matchMedia = () => ({ matches: true });
    window.screen = { width: 844, height: 390 };
    assert.equal(isPhone(), true);
    window.screen = { width: 1200, height: 800 };
    assert.equal(isPhone(), false);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("touch holds support simultaneous actions and release on cancellation or reset", () => {
  class Element {
    children = []; dataset = {}; listeners = new Map();
    appendChild(child) { this.children.push(child); }
    setAttribute() {} setPointerCapture() {} remove() {}
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    send(type, pointerId) { this.listeners.get(type)({ pointerId, preventDefault() {} }); }
  }
  const originalDocument = globalThis.document;
  globalThis.document = { createElement: () => new Element(), body: new Element() };
  try {
    const actions = [];
    const controls = new TouchControls(code => actions.push(code));
    const buttons = controls.element.children.flatMap(section => section.children);
    const forward = buttons.find(button => button.dataset.code === "KeyW");
    const up = buttons.find(button => button.dataset.code === "KeyE");
    forward.send("pointerdown", 1);
    up.send("pointerdown", 2);
    assert.deepEqual([...controls.held], ["KeyW", "KeyE"]);
    forward.send("pointercancel", 1);
    assert.deepEqual([...controls.held], ["KeyE"]);
    up.send("lostpointercapture", 2);
    assert.equal(controls.held.size, 0);
    forward.send("pointerdown", 3);
    controls.clear();
    assert.equal(controls.held.size, 0);
    assert.deepEqual(actions, ["KeyW", "KeyE", "KeyW"]);
    controls.dispose();
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
