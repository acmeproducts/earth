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
    eventProbability: mix(
      TWINKLE_ZENITH_PROBABILITY,
      TWINKLE_HORIZON_PROBABILITY,
      horizonProximity,
    ),
    eventStrength: mix(
      TWINKLE_ZENITH_STRENGTH,
      TWINKLE_HORIZON_STRENGTH,
      horizonProximity,
    ),
  };
}

function mix(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}
