export const VEGETATION_DENSITY_TRANSITION_WIDTH = 16;

interface VegetationDensityTransition {
  innerScale: number;
  borderScale: number;
  outerScale: number;
  transitionWidth?: number;
}

/** Smoothly changes tree density across the local terrain footprint boundary. */
export function vegetationDensityScaleAcrossLocalBoundary(
  worldX: number,
  worldZ: number,
  halfLocalWidth: number,
  halfLocalDepth: number,
  transition: VegetationDensityTransition,
): number {
  const signedInsideDistance = Math.min(
    halfLocalWidth - Math.abs(worldX),
    halfLocalDepth - Math.abs(worldZ),
  );
  const width = Math.max(
    0.0001,
    transition.transitionWidth ?? VEGETATION_DENSITY_TRANSITION_WIDTH,
  );
  const distanceFromBorder = Math.min(1, Math.abs(signedInsideDistance) / width);
  const amount = distanceFromBorder * distanceFromBorder * (3 - 2 * distanceFromBorder);
  const awayFromBorderScale = signedInsideDistance >= 0
    ? transition.innerScale
    : transition.outerScale;
  return transition.borderScale +
    (awayFromBorderScale - transition.borderScale) * amount;
}

export function estimateVistaVegetationCandidates(
  widthMeters: number,
  depthMeters: number,
  spacingMeters: number,
): number {
  return Math.ceil(widthMeters / spacingMeters) * Math.ceil(depthMeters / spacingMeters);
}

/** Keeps one-shot source generation bounded while retaining local density on smaller vistas. */
export function chooseVistaVegetationSpacing(
  widthMeters: number,
  depthMeters: number,
  maximumCandidates = 750_000,
  minimumSpacingMeters = 3.5,
): number {
  return Math.max(
    minimumSpacingMeters,
    Math.sqrt((widthMeters * depthMeters) / maximumCandidates),
  );
}
