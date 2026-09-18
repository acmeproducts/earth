import assert from "node:assert/strict";

const frames = new WeakMap();
/** Advance the after-render callbacks without paying for an actual headless draw. */
export function advanceInteriorFrame(scene) {
  const original = scene.getFrameId;
  const frame = (frames.get(scene) ?? original.call(scene)) + 1;
  frames.set(scene, frame);
  scene.getFrameId = () => frame;
  try { scene.onAfterRenderObservable.notifyObservers(scene); }
  finally { scene.getFrameId = original; }
}

export function drainInteriorBuilds(scene, done = () =>
  scene.meshes.every((mesh) => !mesh.metadata?.loadingInteriorCount), maxFrames = 20000) {
  for (let frame = 0; frame < maxFrames; frame++) {
    advanceInteriorFrame(scene);
    if (done()) return frame + 1;
  }
  assert.fail(`Interior build did not finish in ${maxFrames} simulated frames`);
}
