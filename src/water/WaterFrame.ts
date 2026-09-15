import type { Scene } from '@babylonjs/core';
import { currentWindState } from '../vegetation/Wind';
import type { WindState } from '../vegetation/Wind';

const frames = new WeakMap<Scene, {
  id: number;
  seconds: number;
  wind: WindState;
  driftX: number;
  driftY: number;
}>();

/** Water responds sublinearly to wind, and stops completely in calm weather. */
export function waterMotionSpeed(windStrength: number, exposure = 1): number {
  return 1.25 * Math.sqrt(Math.max(0, windStrength)) * Math.max(0, exposure);
}

/** All pieces of water sample exactly the same clock and wind in a frame. */
export function waterFrame(scene: Scene) {
  const id = scene.getFrameId();
  let frame = frames.get(scene);
  if (!frame || frame.id !== id) {
    const now = performance.now();
    const seconds = now / 1000;
    const wind = currentWindState(now);
    // Integrate velocity, never multiply changing wind by the page's age.
    // Cap long pauses so returning to a background tab cannot jump the waves.
    const elapsed = frame ? Math.min(0.1, Math.max(0, seconds - frame.seconds)) : 0;
    const distance = elapsed * waterMotionSpeed(wind.strength);
    frame = {
      id, seconds, wind,
      driftX: (frame?.driftX ?? 0) + distance * wind.direction.x,
      driftY: (frame?.driftY ?? 0) + distance * wind.direction.y,
    };
    frames.set(scene, frame);
  }
  return frame;
}
