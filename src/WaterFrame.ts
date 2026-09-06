import type { Scene } from '@babylonjs/core';
import { currentWindState } from './Wind';
import type { WindState } from './Wind';

const frames = new WeakMap<Scene, { id: number; seconds: number; wind: WindState }>();

/** All pieces of water sample exactly the same clock and wind in a frame. */
export function waterFrame(scene: Scene) {
  const id = scene.getFrameId();
  let frame = frames.get(scene);
  if (!frame || frame.id !== id) {
    const now = performance.now();
    frame = { id, seconds: now / 1000, wind: currentWindState(now) };
    frames.set(scene, frame);
  }
  return frame;
}
