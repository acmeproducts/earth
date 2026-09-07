import { clamp01, smoothstep } from "./MathUtils";

export type WaterSurfaceKind = 'ocean' | 'lake';

export interface WaterProfile {
  color: readonly [number, number, number];
  glossiness: number;
  swellNormal: number;
  chopNormal: number;
  exposure: number;
  periodSeconds: number;
  heaveMeters: number;
  crestMeters: number;
  foamStrength: number;
}

/** Sea and lake are parameter sets for exactly the same material and motion. */
export const WATER_PROFILES: Readonly<Record<WaterSurfaceKind, WaterProfile>> = {
  ocean: {
    color: [0.05, 0.2, 0.4], glossiness: 0.9,
    swellNormal: 0.9, chopNormal: 0.6, exposure: 1,
    periodSeconds: 6.5, heaveMeters: 0.09, crestMeters: 0.22, foamStrength: 0.24,
  },
  lake: {
    color: [0.055, 0.24, 0.29], glossiness: 0.84,
    swellNormal: 0.72, chopNormal: 0.38, exposure: 0.62,
    periodSeconds: 7.8, heaveMeters: 0.035, crestMeters: 0.07, foamStrength: 0.07,
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
  const heave = Math.sin(phase) * profile.heaveMeters * strength;
  const crest = Math.pow(Math.max(0, Math.sin(phase - d * 1.15)), 3) * band;
  return { heave, crest, height: heave + crest * profile.crestMeters * strength };
}
