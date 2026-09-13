export interface CoastlineElevationGrid {
  elevations: Float32Array;
  minElevation: number;
  maxElevation: number;
  width: number;
  height: number;
  /** Signed metres from the smoothed shore; positive on land. */
  shoreDistanceMeters?: Float32Array;
}

export interface CoastlineShapeOptions {
  metersPerPixelX: number;
  metersPerPixelY: number;
  /** Distance over which land settles toward the waterline. */
  landBlendWidthMeters: number;
  /** Distance over which the shallow shelf descends to deep water. */
  waterBlendWidthMeters: number;
  deepWaterCeilingMeters: number;
  shallowWaterDepthMeters?: number;
}

export interface CoastlineSampleGrid {
  coverage: Float32Array;
  water: Uint8Array;
  width: number;
  height: number;
  /** Terrain grid origin inside this potentially padded sample grid. */
  terrainOffsetX?: number;
  terrainOffsetY?: number;
}

/**
 * Shapes both sides of a classified shoreline into one continuous profile.
 * Water stays safely beneath the surface while avoiding a vertical drop at
 * every first water vertex.
 */
export async function shapeCoastlineElevations(
  terrain: CoastlineElevationGrid,
  samples: CoastlineSampleGrid,
  options: CoastlineShapeOptions,
  yieldControl?: () => Promise<void>,
): Promise<void> {
  const {
    metersPerPixelX,
    metersPerPixelY,
    landBlendWidthMeters,
    waterBlendWidthMeters,
    deepWaterCeilingMeters,
    shallowWaterDepthMeters = -2,
  } = options;
  const {
    coverage,
    water,
    width: sampleWidth,
    height: sampleHeight,
    terrainOffsetX = 0,
    terrainOffsetY = 0,
  } = samples;
  if (coverage.length !== sampleWidth * sampleHeight || water.length !== coverage.length) {
    throw new Error("Coastline coverage must match its sample grid dimensions.");
  }
  if (
    terrainOffsetX < 0 ||
    terrainOffsetY < 0 ||
    terrainOffsetX + terrain.width > sampleWidth ||
    terrainOffsetY + terrain.height > sampleHeight
  ) {
    throw new Error("Terrain must fit inside the coastline sample grid.");
  }
  if (shallowWaterDepthMeters >= 0) {
    throw new Error("Shallow coastline depth must remain below sea level.");
  }

  // With no water anywhere in the context, every shore distance is infinite.
  // Keep the common elevation pass so clearance, bounds and distance caps agree.
  const hasWater = coverage.some(value => value !== 0) || water.some(value => value !== 0);
  const distance = hasWater ? await distanceFromShore(
    water,
    coverage,
    sampleWidth,
    sampleHeight,
    metersPerPixelX,
    metersPerPixelY,
    yieldControl,
  ) : undefined;
  const landClearance = 0.25;
  terrain.shoreDistanceMeters = new Float32Array(terrain.width * terrain.height);

  terrain.minElevation = Infinity;
  terrain.maxElevation = -Infinity;
  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      const terrainIndex = y * terrain.width + x;
      const sampleIndex = (y + terrainOffsetY) * sampleWidth + x + terrainOffsetX;
      const isWater = water[sampleIndex] === 1;
      const shoreDistance = Math.min(1e6, distance?.[sampleIndex] ?? Infinity);
      terrain.shoreDistanceMeters[terrainIndex] = isWater ? -shoreDistance : shoreDistance;
      const blendWidth = isWater ? waterBlendWidthMeters : landBlendWidthMeters;
      const amount = Math.min(1, shoreDistance / blendWidth);
      const blend = amount * amount * (3 - 2 * amount);
      const shorelineElevation = isWater
        ? shallowWaterDepthMeters * Math.min(1, shoreDistance / 20)
        : Math.min(landClearance, shoreDistance * 0.1);
      const corrected = isWater
        ? Math.min(terrain.elevations[terrainIndex], deepWaterCeilingMeters)
        : Math.max(terrain.elevations[terrainIndex], landClearance);
      const elevation = shorelineElevation + (corrected - shorelineElevation) * blend;
      terrain.elevations[terrainIndex] = elevation;
      terrain.minElevation = Math.min(terrain.minElevation, terrain.elevations[terrainIndex]);
      terrain.maxElevation = Math.max(terrain.maxElevation, terrain.elevations[terrainIndex]);
    }
    await yieldControl?.();
  }
}

async function distanceFromShore(
  water: Uint8Array,
  coverage: Float32Array,
  width: number,
  height: number,
  metersPerPixelX: number,
  metersPerPixelY: number,
  yieldControl?: () => Promise<void>,
): Promise<Float32Array> {
  const distance = new Float32Array(water.length).fill(Infinity);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      let nearestBoundary = Infinity;
      // Recover a subpixel contour from the continuous coverage. Thresholding
      // first and measuring to cell edges throws away this information and
      // recreates a staircase even after the classification was smoothed.
      const left = Math.max(0, x - 1);
      const right = Math.min(width - 1, x + 1);
      const top = Math.max(0, y - 1);
      const bottom = Math.min(height - 1, y + 1);
      const dx = (coverage[y * width + right] - coverage[y * width + left]) /
        (Math.max(1, right - left) * metersPerPixelX);
      const dy = (coverage[bottom * width + x] - coverage[top * width + x]) /
        (Math.max(1, bottom - top) * metersPerPixelY);
      const gradient = Math.hypot(dx, dy);
      const contourDistance = gradient > 1e-8
        ? Math.abs(coverage[index] - 0.5) / gradient
        : Infinity;
      if (contourDistance <= 2 * Math.max(metersPerPixelX, metersPerPixelY)) {
        nearestBoundary = contourDistance;
      }
      if (
        (x > 0 && water[index - 1] !== water[index]) ||
        (x + 1 < width && water[index + 1] !== water[index])
      ) nearestBoundary = Number.isFinite(contourDistance)
        ? contourDistance : distanceToCellEdge(metersPerPixelX);
      if (
        (y > 0 && water[index - width] !== water[index]) ||
        (y + 1 < height && water[index + width] !== water[index])
      ) nearestBoundary = Math.min(
        nearestBoundary,
        Number.isFinite(contourDistance) ? contourDistance : distanceToCellEdge(metersPerPixelY),
      );
      distance[index] = nearestBoundary;
    }
    await yieldControl?.();
  }

  await distancePass(
    distance,
    width,
    height,
    metersPerPixelX,
    metersPerPixelY,
    false,
    yieldControl,
  );
  await distancePass(
    distance,
    width,
    height,
    metersPerPixelX,
    metersPerPixelY,
    true,
    yieldControl,
  );
  return distance;
}

function distanceToCellEdge(pixelSpacing: number): number {
  return pixelSpacing * 0.5;
}

async function distancePass(
  distance: Float32Array,
  width: number,
  height: number,
  horizontalDistance: number,
  verticalDistance: number,
  reverse: boolean,
  yieldControl?: () => Promise<void>,
): Promise<void> {
  const diagonal = Math.hypot(horizontalDistance, verticalDistance);
  for (let row = 0; row < height; row++) {
    const y = reverse ? height - 1 - row : row;
    for (let column = 0; column < width; column++) {
      const x = reverse ? width - 1 - column : column;
      const index = y * width + x;
      const horizontal = x + (reverse ? 1 : -1);
      const vertical = y + (reverse ? 1 : -1);
      if (horizontal >= 0 && horizontal < width) {
        distance[index] = Math.min(
          distance[index],
          distance[y * width + horizontal] + horizontalDistance,
        );
      }
      if (vertical >= 0 && vertical < height) {
        distance[index] = Math.min(
          distance[index],
          distance[vertical * width + x] + verticalDistance,
        );
        if (horizontal >= 0 && horizontal < width) {
          distance[index] = Math.min(
            distance[index],
            distance[vertical * width + horizontal] + diagonal,
          );
        }
        const otherHorizontal = x + (reverse ? -1 : 1);
        if (otherHorizontal >= 0 && otherHorizontal < width) {
          distance[index] = Math.min(
            distance[index],
            distance[vertical * width + otherHorizontal] + diagonal,
          );
        }
      }
    }
    await yieldControl?.();
  }
}
