import { CLOUD_VARIANT_COUNT, cloudRandom } from "./CloudDistribution";
import { clamp01 } from "./MathUtils";

export const CLOUD_TEXTURE_WIDTH = 128;
export const CLOUD_TEXTURE_HEIGHT = 64;
export const CLOUD_TEXTURE_GUTTER = 2;
export const CLOUD_ATLAS_COLUMNS = 4;
export const CLOUD_VIEW_COUNT = 8;
export const CLOUD_SHADOW_TEXTURE_SIZE = 96;

const CLOUD_CAPTURE_STEPS = 24;
const CLOUD_SHADOW_CAPTURE_PADDING = 1.02;
const CLOUD_MEAN_HEIGHT_TO_WIDTH = 1 / 1.9;
const CLOUD_MEAN_HEIGHT_TO_DEPTH = CLOUD_MEAN_HEIGHT_TO_WIDTH / 0.52;

interface CloudLobe {
  x: number;
  y: number;
  z: number;
  radiusX: number;
  radiusY: number;
  radiusZ: number;
  strength: number;
}

export interface CloudDensityAtlasData {
  pixels: Uint8Array;
  width: number;
  height: number;
  tileStrideX: number;
  tileStrideY: number;
}

export interface CloudShadowFootprintScale {
  readonly x: number;
  readonly z: number;
}

/** Expansion caused by sunlight crossing the cloud's finite vertical depth. */
export function cloudShadowFootprintScale(
  sunDirection: Readonly<{ x: number; y: number; z: number }>,
): CloudShadowFootprintScale {
  const projectionY = Math.max(sunDirection.y, 0.08);
  const raySlopeX = sunDirection.x / projectionY * CLOUD_MEAN_HEIGHT_TO_WIDTH;
  const raySlopeZ = sunDirection.z / projectionY * CLOUD_MEAN_HEIGHT_TO_DEPTH;
  return {
    x: (CLOUD_SHADOW_CAPTURE_PADDING + Math.abs(raySlopeX))
      / CLOUD_SHADOW_CAPTURE_PADDING,
    z: (CLOUD_SHADOW_CAPTURE_PADDING + Math.abs(raySlopeZ))
      / CLOUD_SHADOW_CAPTURE_PADDING,
  };
}

/** Integrates several deterministic 3D density fields into one view atlas. */
export function generateCloudDensityAtlasData(): CloudDensityAtlasData {
  const tileStrideX = CLOUD_TEXTURE_WIDTH + CLOUD_TEXTURE_GUTTER * 2;
  const tileStrideY = CLOUD_TEXTURE_HEIGHT + CLOUD_TEXTURE_GUTTER * 2;
  const width = tileStrideX * CLOUD_ATLAS_COLUMNS;
  const tileCount = CLOUD_VARIANT_COUNT * CLOUD_VIEW_COUNT;
  const height = tileStrideY * Math.ceil(tileCount / CLOUD_ATLAS_COLUMNS);
  const pixels = new Uint8Array(width * height * 4);
  for (let variant = 0; variant < CLOUD_VARIANT_COUNT; variant++) {
    for (let view = 0; view < CLOUD_VIEW_COUNT; view++) {
      const tile = renderCloudVariant(variant, view);
      const tileIndex = variant * CLOUD_VIEW_COUNT + view;
      writeAtlasTile(
        pixels,
        width,
        tile,
        (tileIndex % CLOUD_ATLAS_COLUMNS) * tileStrideX,
        Math.floor(tileIndex / CLOUD_ATLAS_COLUMNS) * tileStrideY,
      );
    }
  }
  return { pixels, width, height, tileStrideX, tileStrideY };
}

/** Captures the same volume from above for the inexpensive ground projector. */
export function generateCloudShadowAtlasData(
  sunDirection: Readonly<{ x: number; y: number; z: number }> = { x: 0, y: 1, z: 0 },
): CloudDensityAtlasData {
  const tileStrideX = CLOUD_SHADOW_TEXTURE_SIZE + CLOUD_TEXTURE_GUTTER * 2;
  const tileStrideY = tileStrideX;
  const width = tileStrideX * CLOUD_ATLAS_COLUMNS;
  const height = tileStrideY * Math.ceil(CLOUD_VARIANT_COUNT / CLOUD_ATLAS_COLUMNS);
  const pixels = new Uint8Array(width * height * 4);
  for (let variant = 0; variant < CLOUD_VARIANT_COUNT; variant++) {
    writeAtlasTile(
      pixels,
      width,
      renderCloudShadowVariant(variant, sunDirection),
      (variant % CLOUD_ATLAS_COLUMNS) * tileStrideX,
      Math.floor(variant / CLOUD_ATLAS_COLUMNS) * tileStrideY,
      CLOUD_SHADOW_TEXTURE_SIZE,
      CLOUD_SHADOW_TEXTURE_SIZE,
    );
  }
  return { pixels, width, height, tileStrideX, tileStrideY };
}

function renderCloudVariant(variant: number, view: number): Uint8Array {
  const lobes = cloudLobes(variant);
  const opticalDepthGain = lerp(
    4.2,
    5.8,
    (lobeRandom(variant, 0, 10) + lobeRandom(variant, 1, 10)) * 0.5,
  );
  const pixels = new Uint8Array(CLOUD_TEXTURE_WIDTH * CLOUD_TEXTURE_HEIGHT * 4);
  const elevation = 25 * Math.PI / 180;
  const azimuth = view * Math.PI * 2 / CLOUD_VIEW_COUNT;
  const sinAzimuth = Math.sin(azimuth);
  const cosAzimuth = Math.cos(azimuth);
  const upY = Math.cos(elevation);
  const upHorizontal = -Math.sin(elevation);
  const rayY = -Math.sin(elevation);
  const rayHorizontal = -Math.cos(elevation);
  const rayStep = 2 / CLOUD_CAPTURE_STEPS;

  for (let y = 0; y < CLOUD_TEXTURE_HEIGHT; y++) {
    const imageY = (1 - (y + 0.5) / CLOUD_TEXTURE_HEIGHT * 2) * 0.62;
    for (let x = 0; x < CLOUD_TEXTURE_WIDTH; x++) {
      const imageX = ((x + 0.5) / CLOUD_TEXTURE_WIDTH * 2 - 1) * 1.02;
      let opticalDepth = 0;
      let peakDensity = 0;
      for (let step = 0; step < CLOUD_CAPTURE_STEPS; step++) {
        const ray = -1 + (step + 0.5) * rayStep;
        const sampleX = imageX * cosAzimuth
          + imageY * upHorizontal * sinAzimuth
          + ray * rayHorizontal * sinAzimuth;
        const sampleY = imageY * upY + ray * rayY;
        const sampleZ = imageX * -sinAzimuth
          + imageY * upHorizontal * cosAzimuth
          + ray * rayHorizontal * cosAzimuth;
        const density = cloudDensity(lobes, sampleX, sampleY, sampleZ, variant);
        opticalDepth += density * rayStep;
        peakDensity = Math.max(peakDensity, density);
      }
      const coverage = 1 - Math.exp(-opticalDepth * opticalDepthGain);
      const target = (y * CLOUD_TEXTURE_WIDTH + x) * 4;
      pixels[target] = Math.round(clamp01(coverage) * 255);
      pixels[target + 1] = Math.round(clamp01(peakDensity) * 255);
      pixels[target + 3] = 255;
    }
  }
  return pixels;
}

function renderCloudShadowVariant(
  variant: number,
  sunDirection: Readonly<{ x: number; y: number; z: number }>,
): Uint8Array {
  const lobes = cloudLobes(variant);
  const pixels = new Uint8Array(
    CLOUD_SHADOW_TEXTURE_SIZE * CLOUD_SHADOW_TEXTURE_SIZE * 4,
  );
  const rayStep = 2 / CLOUD_CAPTURE_STEPS;
  const projectionY = Math.max(sunDirection.y, 0.08);
  // Placements vary slightly, but these mean proportions align the shared
  // atlas closely with the ray through a typical cloud bank.
  const raySlopeX = sunDirection.x / projectionY * CLOUD_MEAN_HEIGHT_TO_WIDTH;
  const raySlopeZ = sunDirection.z / projectionY * CLOUD_MEAN_HEIGHT_TO_DEPTH;
  const footprintScale = cloudShadowFootprintScale(sunDirection);
  const captureExtentX = CLOUD_SHADOW_CAPTURE_PADDING * footprintScale.x;
  const captureExtentZ = CLOUD_SHADOW_CAPTURE_PADDING * footprintScale.z;
  for (let z = 0; z < CLOUD_SHADOW_TEXTURE_SIZE; z++) {
    const baseZ = ((z + 0.5) / CLOUD_SHADOW_TEXTURE_SIZE * 2 - 1)
      * captureExtentZ;
    for (let x = 0; x < CLOUD_SHADOW_TEXTURE_SIZE; x++) {
      const baseX = ((x + 0.5) / CLOUD_SHADOW_TEXTURE_SIZE * 2 - 1)
        * captureExtentX;
      let opticalDepth = 0;
      for (let step = 0; step < CLOUD_CAPTURE_STEPS; step++) {
        const sampleY = -1 + (step + 0.5) * rayStep;
        opticalDepth += cloudDensity(
          lobes,
          baseX + raySlopeX * sampleY,
          sampleY,
          baseZ + raySlopeZ * sampleY,
          variant,
        ) * rayStep;
      }
      const coverage = 1 - Math.exp(-opticalDepth * 4.8);
      const target = (z * CLOUD_SHADOW_TEXTURE_SIZE + x) * 4;
      pixels[target] = Math.round(clamp01(coverage) * 255);
      pixels[target + 1] = pixels[target];
      pixels[target + 2] = pixels[target];
      pixels[target + 3] = 255;
    }
  }
  return pixels;
}

function cloudLobes(variant: number): CloudLobe[] {
  switch (variant % 4) {
    case 0: return bankLobes(variant);
    case 1: return clusteredLobes(variant);
    case 2: return brokenLobes(variant);
    default: return towerLobes(variant);
  }
}

function bankLobes(variant: number): CloudLobe[] {
  const slope = lerp(-0.1, 0.1, lobeRandom(variant, 0, 8));
  const lobes: CloudLobe[] = [
    makeLobe(-0.28, -0.1 - slope, 0.02, 0.62, 0.22, 0.4, 0.9),
    makeLobe(0.32, -0.1 + slope, -0.04, 0.56, 0.2, 0.36, 0.88),
  ];
  for (let index = 0; index < 10; index++) {
    const x = lerp(-0.75, 0.75, lobeRandom(variant, index, 0));
    const centerBias = 1 - Math.min(1, Math.abs(x) / 0.75);
    lobes.push(makeLobe(
      x,
      lerp(-0.16, 0.08 + centerBias * 0.14, lobeRandom(variant, index, 1)) + x * slope,
      lerp(-0.3, 0.3, lobeRandom(variant, index, 2)),
      lerp(0.18, 0.36, lobeRandom(variant, index, 3)),
      lerp(0.12, 0.25, lobeRandom(variant, index, 4)),
      lerp(0.2, 0.4, lobeRandom(variant, index, 5)),
      lerp(0.72, 1.08, lobeRandom(variant, index, 6)),
    ));
  }
  return lobes;
}

function clusteredLobes(variant: number): CloudLobe[] {
  const anchorX = lerp(-0.18, 0.18, lobeRandom(variant, 0, 9));
  const lobes: CloudLobe[] = [
    makeLobe(anchorX, -0.1, 0, 0.64, 0.3, 0.48, 0.94),
  ];
  for (let index = 0; index < 10; index++) {
    const x = anchorX + lerp(-0.58, 0.58, lobeRandom(variant, index, 0));
    const centerBias = 1 - Math.min(1, Math.abs(x - anchorX) / 0.58);
    lobes.push(makeLobe(
      x,
      lerp(-0.14, 0.16 + centerBias * 0.2, lobeRandom(variant, index, 1)),
      lerp(-0.42, 0.42, lobeRandom(variant, index, 2)),
      lerp(0.2, 0.42, lobeRandom(variant, index, 3)),
      lerp(0.16, 0.34, lobeRandom(variant, index, 4)),
      lerp(0.22, 0.44, lobeRandom(variant, index, 5)),
      lerp(0.7, 1.1, lobeRandom(variant, index, 6)),
    ));
  }
  return lobes;
}

function brokenLobes(variant: number): CloudLobe[] {
  const leftY = lerp(-0.13, 0.02, lobeRandom(variant, 0, 8));
  const rightY = lerp(-0.12, 0.08, lobeRandom(variant, 1, 8));
  const lobes: CloudLobe[] = [
    makeLobe(-0.4, leftY, 0.02, 0.4, 0.25, 0.38, 0.94),
    makeLobe(0.41, rightY, -0.04, 0.36, 0.22, 0.34, 0.9),
  ];
  for (let index = 0; index < 10; index++) {
    const left = index < 6;
    const anchorX = left ? -0.42 : 0.43;
    const anchorY = left ? leftY : rightY;
    lobes.push(makeLobe(
      anchorX + lerp(-0.24, 0.24, lobeRandom(variant, index, 0)),
      anchorY + lerp(-0.08, 0.28, lobeRandom(variant, index, 1)),
      lerp(-0.36, 0.36, lobeRandom(variant, index, 2)),
      lerp(0.17, 0.32, lobeRandom(variant, index, 3)),
      lerp(0.14, 0.28, lobeRandom(variant, index, 4)),
      lerp(0.2, 0.38, lobeRandom(variant, index, 5)),
      lerp(0.74, 1.1, lobeRandom(variant, index, 6)),
    ));
  }
  return lobes;
}

function towerLobes(variant: number): CloudLobe[] {
  const towerX = lerp(-0.22, 0.22, lobeRandom(variant, 0, 9));
  const lobes: CloudLobe[] = [
    makeLobe(0, -0.16, 0, 0.72, 0.2, 0.44, 0.94),
    makeLobe(towerX, 0.02, 0.02, 0.38, 0.34, 0.4, 1.02),
    makeLobe(towerX * 1.18, 0.28, -0.04, 0.3, 0.24, 0.34, 1.06),
  ];
  for (let index = 0; index < 7; index++) {
    const upper = index >= 4;
    lobes.push(makeLobe(
      (upper ? towerX : 0) + lerp(-0.38, 0.38, lobeRandom(variant, index, 0)),
      lerp(-0.16, upper ? 0.34 : 0.13, lobeRandom(variant, index, 1)),
      lerp(-0.34, 0.34, lobeRandom(variant, index, 2)),
      lerp(0.18, upper ? 0.32 : 0.38, lobeRandom(variant, index, 3)),
      lerp(0.14, 0.28, lobeRandom(variant, index, 4)),
      lerp(0.2, 0.4, lobeRandom(variant, index, 5)),
      lerp(0.74, 1.1, lobeRandom(variant, index, 6)),
    ));
  }
  return lobes;
}

function makeLobe(
  x: number,
  y: number,
  z: number,
  radiusX: number,
  radiusY: number,
  radiusZ: number,
  strength: number,
): CloudLobe {
  return { x, y, z, radiusX, radiusY, radiusZ, strength };
}

function lobeRandom(variant: number, index: number, channel: number): number {
  return cloudRandom(variant, index, 7_491, channel);
}

function cloudDensity(
  lobes: readonly CloudLobe[],
  x: number,
  y: number,
  z: number,
  variant: number,
): number {
  let density = 0;
  for (const lobe of lobes) {
    const dx = (x - lobe.x) / lobe.radiusX;
    const dy = (y - lobe.y) / lobe.radiusY;
    const dz = (z - lobe.z) / lobe.radiusZ;
    const radiusSquared = dx * dx + dy * dy + dz * dz;
    if (radiusSquared >= 1) continue;
    const influence = 1 - radiusSquared;
    density += influence * influence * lobe.strength;
  }
  if (density <= 0.08) return 0;
  const detail = valueNoise3D(x * 4.2, y * 5.4, z * 4.2, variant);
  return Math.max(0, density * (0.78 + detail * 0.42) - 0.08);
}

function valueNoise3D(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = smoothFraction(x - x0);
  const ty = smoothFraction(y - y0);
  const tz = smoothFraction(z - z0);
  const sample = (dx: number, dy: number, dz: number): number => (
    cloudRandom(x0 + dx, z0 + dz, seed * 1_009 + y0 + dy, 13)
  );
  const x00 = lerp(sample(0, 0, 0), sample(1, 0, 0), tx);
  const x10 = lerp(sample(0, 1, 0), sample(1, 1, 0), tx);
  const x01 = lerp(sample(0, 0, 1), sample(1, 0, 1), tx);
  const x11 = lerp(sample(0, 1, 1), sample(1, 1, 1), tx);
  return lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz);
}

function writeAtlasTile(
  atlas: Uint8Array,
  atlasWidth: number,
  tile: Uint8Array,
  originX: number,
  originY: number,
  tileWidth = CLOUD_TEXTURE_WIDTH,
  tileHeight = CLOUD_TEXTURE_HEIGHT,
): void {
  for (
    let y = -CLOUD_TEXTURE_GUTTER;
    y < tileHeight + CLOUD_TEXTURE_GUTTER;
    y++
  ) {
    const sourceY = Math.max(0, Math.min(tileHeight - 1, y));
    for (let x = -CLOUD_TEXTURE_GUTTER; x < tileWidth + CLOUD_TEXTURE_GUTTER; x++) {
      const sourceX = Math.max(0, Math.min(tileWidth - 1, x));
      const source = (sourceY * tileWidth + sourceX) * 4;
      const target = (
        (originY + y + CLOUD_TEXTURE_GUTTER) * atlasWidth
        + originX + x + CLOUD_TEXTURE_GUTTER
      ) * 4;
      atlas[target] = tile[source];
      atlas[target + 1] = tile[source + 1];
      atlas[target + 2] = tile[source + 2];
      atlas[target + 3] = tile[source + 3];
    }
  }
}

function smoothFraction(value: number): number {
  return value * value * (3 - 2 * value);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}
