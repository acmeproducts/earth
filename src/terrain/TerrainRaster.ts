/** Visits scene-space raster samples, yielding once after each complete row. */
export async function visitTerrainRaster(
  grid: { width: number; height: number },
  extent: { meshWidth: number; meshDepth: number },
  visit: (index: number, x: number, z: number) => void,
  yieldControl?: () => Promise<void>,
): Promise<void> {
  for (let row = 0; row < grid.height; row++) {
    const z = (0.5 - row / Math.max(1, grid.height - 1)) * extent.meshDepth;
    for (let column = 0; column < grid.width; column++) {
      const x = (column / Math.max(1, grid.width - 1) - 0.5) * extent.meshWidth;
      visit(row * grid.width + column, x, z);
    }
    await yieldControl?.();
  }
}
