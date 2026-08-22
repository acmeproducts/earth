export interface CoastlineElevationGrid {
  elevations: Float32Array;
  minElevation: number;
  maxElevation: number;
  width: number;
  height: number;
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

  const distance = await distanceFromShore(
    water,
    sampleWidth,
    sampleHeight,
    metersPerPixelX,
    metersPerPixelY,
    yieldControl,
  );
  const landClearance = 0.25;

  terrain.minElevation = Infinity;
  terrain.maxElevation = -Infinity;
  for (let y = 0; y < terrain.height; y++) {
    for (let x = 0; x < terrain.width; x++) {
      const terrainIndex = y * terrain.width + x;
      const sampleIndex = (y + terrainOffsetY) * sampleWidth + x + terrainOffsetX;
      const isWater = water[sampleIndex] === 1;
      const blendWidth = isWater ? waterBlendWidthMeters : landBlendWidthMeters;
      const amount = Math.min(1, distance[sampleIndex] / blendWidth);
      const blend = amount * amount * (3 - 2 * amount);
      const shorelineElevation = isWater
        ? shallowWaterDepthMeters
        : landClearance * Math.max(0, 1 - 2 * coverage[sampleIndex]);
      const corrected = isWater
        ? Math.min(terrain.elevations[terrainIndex], deepWaterCeilingMeters)
        : Math.max(terrain.elevations[terrainIndex], landClearance);
      const elevation = shorelineElevation + (corrected - shorelineElevation) * blend;
      terrain.elevations[terrainIndex] = elevation;
      terrain.minElevation = Math.min(terrain.minElevation, elevation);
      terrain.maxElevation = Math.max(terrain.maxElevation, elevation);
    }
    await yieldControl?.();
  }
}

async function distanceFromShore(
  water: Uint8Array,
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
      if (
        (x > 0 && water[index - 1] !== water[index]) ||
        (x + 1 < width && water[index + 1] !== water[index])
      ) nearestBoundary = distanceToCellEdge(metersPerPixelX);
      if (
        (y > 0 && water[index - width] !== water[index]) ||
        (y + 1 < height && water[index + width] !== water[index])
      ) nearestBoundary = Math.min(
        nearestBoundary,
        distanceToCellEdge(metersPerPixelY),
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
