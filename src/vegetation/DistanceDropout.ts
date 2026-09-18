/**
 * Distance thinning for low ground cover. Rather than fading pixels, which
 * needs translucency and shows whatever stands behind a clump, each instance
 * shrinks toward its root over a short window and then disappears entirely.
 * Instances drop out in a stable per-instance order, so the field visibly
 * thins with distance while every surviving clump stays opaque.
 */
export const DISTANCE_DROPOUT_UNIFORMS: readonly string[] = [
  "distanceFadeNear",
  "distanceFadeFar",
];

/** Keep cover dense until the outer fifth of the circular detail radius. */
export function vegetationDistanceFadeRange(tileWidth: number, detailTilesAcross: number): {
  near: number;
  far: number;
} {
  const far = Math.max(0, tileWidth) * Math.max(1, Math.round(detailTilesAcross)) / 2;
  return { near: far * 0.8, far };
}

/** Fraction of the survival range a clump spends shrinking before it drops. */
const DISTANCE_DROPOUT_SHRINK_FRACTION = 0.15;

export const distanceDropoutVertexDeclaration = `
uniform float distanceFadeNear;
uniform float distanceFadeFar;
const float DISTANCE_DROPOUT_SHRINK = ${DISTANCE_DROPOUT_SHRINK_FRACTION.toFixed(3)};

float distanceDropoutHash(vec2 origin) {
  return fract(sin(dot(origin, vec2(12.9898, 78.233))) * 43758.5453);
}

// Per-instance scale for the distance thinning: 1 inside the full-detail
// range, shrinking toward the root as the instance approaches its own dropout
// threshold, and 0 once it has dropped. survival receives the fraction of the
// field that still stands at this distance (1 near, 0 at the far edge).
float distanceDropoutScale(vec3 instanceOrigin, vec3 cameraPosition, out float survival) {
  survival = 1.0 - smoothstep(
    distanceFadeNear,
    distanceFadeFar,
    length(cameraPosition - instanceOrigin)
  );
  // Thresholds stop short of 1 so every clump stands at full size while the
  // whole field survives, and the last ones only shrink once it starts to thin.
  float threshold = distanceDropoutHash(instanceOrigin.xz) * (1.0 - DISTANCE_DROPOUT_SHRINK);
  return clamp((survival - threshold) / DISTANCE_DROPOUT_SHRINK, 0.0, 1.0);
}
`;
