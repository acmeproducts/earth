/** Relaxes one row of an anisotropic chamfer distance transform in scan order. */
export function distanceTransformRow(
  distance: Float32Array, width: number, height: number,
  horizontalStep: number, verticalStep: number, diagonalStep: number,
  reverse: boolean, y: number,
): void {
  for (let column = 0; column < width; column++) {
    const x = reverse ? width - 1 - column : column;
    const index = y * width + x;
    const horizontal = x + (reverse ? 1 : -1);
    const vertical = y + (reverse ? 1 : -1);

    if (horizontal >= 0 && horizontal < width) {
      distance[index] = Math.min(distance[index], distance[y * width + horizontal] + horizontalStep);
    }
    if (vertical >= 0 && vertical < height) {
      distance[index] = Math.min(distance[index], distance[vertical * width + x] + verticalStep);
      if (horizontal >= 0 && horizontal < width) {
        distance[index] = Math.min(distance[index], distance[vertical * width + horizontal] + diagonalStep);
      }
      const otherHorizontal = x + (reverse ? -1 : 1);
      if (otherHorizontal >= 0 && otherHorizontal < width) {
        distance[index] = Math.min(
          distance[index],
          distance[vertical * width + otherHorizontal] + diagonalStep,
        );
      }
    }
  }
}
