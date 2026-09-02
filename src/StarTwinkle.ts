import { lerp } from "./MathUtils";
export const TWINKLE_ALTITUDE_EXPONENT = 1.8;
export const TWINKLE_ZENITH_PROBABILITY = 0.06;
export const TWINKLE_HORIZON_PROBABILITY = 0.55;
export const TWINKLE_ZENITH_STRENGTH = 0.025;
export const TWINKLE_HORIZON_STRENGTH = 0.18;

export interface StarTwinkleProfile {
  eventProbability: number;
  eventStrength: number;
}

/** Returns the shader's scintillation envelope for an altitude sine. */
export function starTwinkleProfile(altitudeSine: number): StarTwinkleProfile {
  const altitude = Math.max(0, Math.min(1, altitudeSine));
  const horizonProximity = Math.pow(1 - altitude, TWINKLE_ALTITUDE_EXPONENT);
  return {
    eventProbability: lerp(
      TWINKLE_ZENITH_PROBABILITY,
      TWINKLE_HORIZON_PROBABILITY,
      horizonProximity,
    ),
    eventStrength: lerp(
      TWINKLE_ZENITH_STRENGTH,
      TWINKLE_HORIZON_STRENGTH,
      horizonProximity,
    ),
  };
}

