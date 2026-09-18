/** Builds centered grain and a separate micro-relief field from three noise bands. */
export function textureGrain(
  coarse: Float32Array,
  fine: Float32Array,
  specks: Float32Array,
  grainWeights: readonly [number, number, number],
  heightWeights: readonly [number, number, number],
) {
  const grains = new Float32Array(coarse.length);
  const heights = new Float32Array(coarse.length);
  let sum = 0;
  for (let index = 0; index < grains.length; index++) {
    grains[index] = (coarse[index] - 0.5) * grainWeights[0] +
      (fine[index] - 0.5) * grainWeights[1] + (specks[index] - 0.5) * grainWeights[2];
    sum += grains[index];
    heights[index] = coarse[index] * heightWeights[0] +
      fine[index] * heightWeights[1] + specks[index] * heightWeights[2];
  }
  return { grains, heights, grainMean: sum / grains.length };
}
