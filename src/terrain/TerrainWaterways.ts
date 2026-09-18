import type { TerrainData } from './TerrainData';
import type { HorizontalSegment } from '../world/Geo';
import { sampleElevation } from '../world/Geo';
import { riverChannelDepth } from '../water/RiverSurface';

/** Lower mapped channels once, even where provider tiles or tributaries overlap. */
export async function carveTerrainWaterways(
  terrain: TerrainData,
  segments: readonly HorizontalSegment[],
  options: { meshWidth: number; meshDepth: number; metersPerUnit: number },
  yieldControl?: () => Promise<void>,
): Promise<void> {
  if (!segments.length) return;
  const { meshWidth, meshDepth, metersPerUnit } = options;
  const stepX = meshWidth / (terrain.width - 1);
  const stepZ = meshDepth / (terrain.height - 1);
  const depths = new Float32Array(terrain.elevations.length);
  for (const { start, end, halfWidth } of segments) {
    const depth = riverChannelDepth(halfWidth * metersPerUnit);
    // Resolve narrow streams even when their centre falls between DEM samples.
    const bankWidth = Math.max(depth * 2 / metersPerUnit, Math.hypot(stepX, stepZ));
    const radius = halfWidth + bankWidth;
    const minColumn = Math.max(0, Math.floor((Math.min(start.x, end.x) - radius + meshWidth / 2) / stepX));
    const maxColumn = Math.min(terrain.width - 1, Math.ceil((Math.max(start.x, end.x) + radius + meshWidth / 2) / stepX));
    const minRow = Math.max(0, Math.floor((meshDepth / 2 - Math.max(start.z, end.z) - radius) / stepZ));
    const maxRow = Math.min(terrain.height - 1, Math.ceil((meshDepth / 2 - Math.min(start.z, end.z) + radius) / stepZ));
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthSquared = dx * dx + dz * dz;
    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        const x = column * stepX - meshWidth / 2;
        const z = meshDepth / 2 - row * stepZ;
        const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
          ((x - start.x) * dx + (z - start.z) * dz) / lengthSquared));
        const distance = Math.hypot(x - start.x - t * dx, z - start.z - t * dz);
        const bank = Math.max(0, Math.min(1, (radius - distance) / bankWidth));
        const index = row * terrain.width + column;
        if (bank === 0) continue;
        const centreHeight = sampleElevation(terrain, start.x + t * dx, start.z + t * dz,
          meshWidth, meshDepth);
        // Cut the high bank down to the channel bed instead of copying its
        // sideways slope into the river. Never raise the low bank.
        const amount = Math.max(depth, terrain.elevations[index] - centreHeight + depth) *
          bank * bank * (3 - 2 * bank);
        depths[index] = Math.max(depths[index], amount);
      }
      await yieldControl?.();
    }
  }
  terrain.minElevation = Infinity;
  terrain.maxElevation = -Infinity;
  for (let index = 0; index < depths.length; index++) {
    terrain.elevations[index] -= depths[index];
    terrain.minElevation = Math.min(terrain.minElevation, terrain.elevations[index]);
    terrain.maxElevation = Math.max(terrain.maxElevation, terrain.elevations[index]);
  }
}
