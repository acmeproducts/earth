import { smoothstep } from "../core/MathUtils";

/** Blend the neutral terrain grain into wet sand, dry sand, then inland cover. */
export function beachSurfaceColor(
  inland: readonly [number, number, number],
  shoreDistance: number,
  elevation: number,
): readonly [number, number, number] {
  // Elevation limits the band on steep banks; distance limits it on flat land.
  const beach = 1 - smoothstep(8, 24, Math.max(0, shoreDistance));
  const lowBank = 1 - smoothstep(2, 6, elevation);
  const amount = beach * lowBank;
  const dry = smoothstep(0.2, 1.5, elevation);
  const wet = [0.38, 0.33, 0.25];
  const sand = [0.76, 0.69, 0.53];
  return inland.map((value, channel) => {
    const target = wet[channel] + (sand[channel] - wet[channel]) * dry;
    return value + (target - value) * amount;
  }) as [number, number, number];
}
