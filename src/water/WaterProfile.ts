import { clamp01, smoothstep } from "../core/MathUtils";

export type WaterSurfaceKind = 'ocean' | 'lake' | 'river';

export interface WaterProfile {
  color: readonly [number, number, number];
  glossiness: number;
  swellNormal: number;
  chopNormal: number;
  exposure: number;
  periodSeconds: number;
  heaveMeters: number;
  troughMeters: number;
  crestMeters: number;
  foamStrength: number;
}

/** Sea and lake are parameter sets for exactly the same material and motion. */
export const WATER_PROFILES: Readonly<Record<WaterSurfaceKind, WaterProfile>> = {
  ocean: {
    color: [0.05, 0.2, 0.4], glossiness: 0.9,
    swellNormal: 0.9, chopNormal: 0.6, exposure: 1,
    periodSeconds: 6.5, heaveMeters: 0.09, troughMeters: 0.02,
    crestMeters: 0.22, foamStrength: 0.24,
  },
  lake: {
    color: [0.055, 0.24, 0.29], glossiness: 0.84,
    swellNormal: 0.72, chopNormal: 0.38, exposure: 0.62,
    periodSeconds: 7.8, heaveMeters: 0.035, troughMeters: 0.01,
    crestMeters: 0.07, foamStrength: 0.07,
  },
  // A narrow terrain-conforming ribbon cannot use broad vertical heave: even a
  // small uniform lift would periodically pass through road crossings and banks.
  // Moving normal maps still provide visible current without moving the mesh.
  river: {
    color: [0.045, 0.22, 0.25], glossiness: 0.8,
    swellNormal: 0.48, chopNormal: 0.3, exposure: 0.38,
    periodSeconds: 5.4, heaveMeters: 0.002, troughMeters: 0.001,
    crestMeters: 0, foamStrength: 0,
  },
};

/** Physical envelope used to pad the GPU-displaced meshes' CPU bounds. */
export function maximumWaterLift(profile: WaterProfile): number {
  return profile.heaveMeters + profile.crestMeters;
}

/** Reference wave envelope for verification; shoreHeight is bed height in metres. */
export function sampleWaterMotion(seconds: number, wind: number, profile: WaterProfile, shoreHeight = -100) {
  const strength = clamp01(wind);
  const phase = seconds * Math.PI * 2 / profile.periodSeconds;
  const d = shoreHeight * 8;
  const band = smoothstep(-12, -7, d) * (1 - smoothstep(1.6, 3.2, d));
  const wave = Math.sin(phase);
  const heave = wave * (wave < 0 ? profile.troughMeters : profile.heaveMeters) * strength;
  const crest = Math.pow(Math.max(0, Math.sin(phase - d * 1.15)), 3) * band;
  return { heave, crest, height: heave + crest * profile.crestMeters * strength };
}
