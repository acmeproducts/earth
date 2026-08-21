/** Closest geometry the camera may render while walking near the ground. */
export const MIN_CAMERA_NEAR_CLIP_METERS = 0.1;
/** Prevents high-altitude flight from clipping nearby mountains. */
export const MAX_CAMERA_NEAR_CLIP_METERS = 10;
/** Keeps the near plane well inside the empty space below a flying camera. */
export const CAMERA_CLEARANCE_NEAR_FRACTION = 0.05;

/**
 * Raises the near plane as the camera gains altitude. Perspective depth loses
 * precision with the far/near ratio, so keeping a 0.1 m plane during a
 * kilometre-scale view makes water and terrain indistinguishable at distance.
 */
export function adaptiveCameraNearClipMeters(clearanceMeters: number): number {
  if (!Number.isFinite(clearanceMeters)) return MIN_CAMERA_NEAR_CLIP_METERS;
  return Math.max(
    MIN_CAMERA_NEAR_CLIP_METERS,
    Math.min(
      MAX_CAMERA_NEAR_CLIP_METERS,
      clearanceMeters * CAMERA_CLEARANCE_NEAR_FRACTION,
    ),
  );
}
