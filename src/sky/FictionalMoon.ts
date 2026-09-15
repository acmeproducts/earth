import { smoothstep } from "../core/MathUtils";
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
export const FICTIONAL_MOON_PHASE_DAYS = 6;
export const FICTIONAL_MOON_PHASE_EPOCH = Date.UTC(2026, 0, 1);

/** Returns a stable fictional phase from 0 (full) through 0.5 (new). */
export function fictionalMoonPhase(date: Date): number {
  const period = FICTIONAL_MOON_PHASE_DAYS * DAY_MILLISECONDS;
  const elapsed = date.getTime() - FICTIONAL_MOON_PHASE_EPOCH;
  return ((elapsed % period) + period) % period / period;
}

/** Keeps the moon legible without making it disappear from a daytime sky. */
export function fictionalMoonSkyVisibility(sunAltitudeDegrees: number): number {
  const daylight = smoothstep(-4, 20, sunAltitudeDegrees);
  return 1 - daylight * 0.72;
}
