import {
  Color3,
  RawTexture,
  Scene,
  StandardMaterial,
  Texture,
} from "@babylonjs/core";

const TEXTURE_SIZE = 512;
const NOISE_SEED = 0x6d2b79f5;
const ALBEDO_TILING = 24;
const NORMAL_TILING = 48;
let cachedTextureData: TerrainTextureData | undefined;

interface TerrainTextureData {
  albedo: Uint8Array;
  normal: Uint8Array;
}

/** Owns the normal terrain appearance; debug layers are applied elsewhere. */
export function createTerrainMaterial(
  scene: Scene,
  usesLandCoverTint = false,
): StandardMaterial {
  cachedTextureData ??= createTerrainTextureData(TEXTURE_SIZE);
  const textures = cachedTextureData;
  const albedo = RawTexture.CreateRGBATexture(
    textures.albedo,
    TEXTURE_SIZE,
    TEXTURE_SIZE,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  albedo.name = "terrainAlbedo";
  albedo.wrapU = Texture.WRAP_ADDRESSMODE;
  albedo.wrapV = Texture.WRAP_ADDRESSMODE;
  albedo.uScale = ALBEDO_TILING;
  albedo.vScale = ALBEDO_TILING;
  albedo.anisotropicFilteringLevel = 8;

  const normal = RawTexture.CreateRGBATexture(
    textures.normal,
    TEXTURE_SIZE,
    TEXTURE_SIZE,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  normal.name = "terrainNormal";
  normal.gammaSpace = false;
  normal.wrapU = Texture.WRAP_ADDRESSMODE;
  normal.wrapV = Texture.WRAP_ADDRESSMODE;
  normal.uScale = NORMAL_TILING;
  normal.vScale = NORMAL_TILING;
  normal.anisotropicFilteringLevel = 8;
  normal.level = 0.72;

  const material = new StandardMaterial("terrainMaterial", scene);
  material.diffuseTexture = albedo;
  material.bumpTexture = normal;
  material.diffuseColor = usesLandCoverTint
    ? Color3.White()
    : new Color3(0.7, 0.62, 0.5);
  material.specularColor = new Color3(0.035, 0.04, 0.03);
  material.specularPower = 24;
  return material;
}

function createTerrainTextureData(size: number): TerrainTextureData {
  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const broad = fractalNoise(x, y, size, 2, 6, 0.54, NOISE_SEED);
      const clumps = fractalNoise(x, y, size, 7, 5, 0.5, NOISE_SEED ^ 0x51f15e);
      const grains = fractalNoise(x, y, size, 31, 4, 0.46, NOISE_SEED ^ 0x9e3779b9);
      const moss = Math.max(
        0,
        Math.min(1, 0.46 + (broad - 0.5) * 0.45 + (clumps - 0.5) * 0.18),
      );
      const dry = smoothstep(0.69, 0.88, clumps + (grains - 0.5) * 0.2);
      const stone = smoothstep(0.68, 0.84, grains + (clumps - 0.5) * 0.08);

      // Keep the procedural detail close to neutral so land-cover vertex
      // colors determine the surface type without losing small-scale texture.
      let red = mix(208, 184, moss);
      let green = mix(202, 194, moss);
      let blue = mix(186, 170, moss);
      red = mix(red, 220, dry * 0.32);
      green = mix(green, 210, dry * 0.32);
      blue = mix(blue, 180, dry * 0.32);
      red = mix(red, 198, stone * 0.28);
      green = mix(green, 199, stone * 0.28);
      blue = mix(blue, 194, stone * 0.28);

      const grainShade = (grains - 0.5) * 18;
      const index = (y * size + x) * 4;
      albedo[index] = toByte(red + grainShade);
      albedo[index + 1] = toByte(green + grainShade * 0.82);
      albedo[index + 2] = toByte(blue + grainShade * 0.55);
      albedo[index + 3] = 255;

      heights[y * size + x] = clumps * 0.42 + grains * 0.58;
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const left = heights[y * size + wrap(x - 1, size)];
      const right = heights[y * size + wrap(x + 1, size)];
      const up = heights[wrap(y - 1, size) * size + x];
      const down = heights[wrap(y + 1, size) * size + x];
      const nx = (left - right) * 3.2;
      const ny = (up - down) * 3.2;
      const inverseLength = 1 / Math.hypot(nx, ny, 1);
      const index = (y * size + x) * 4;
      normal[index] = toByte((nx * inverseLength * 0.5 + 0.5) * 255);
      normal[index + 1] = toByte((ny * inverseLength * 0.5 + 0.5) * 255);
      normal[index + 2] = toByte(inverseLength * 255);
      normal[index + 3] = 255;
    }
  }

  return { albedo, normal };
}

function fractalNoise(
  x: number,
  y: number,
  textureSize: number,
  startFrequency: number,
  octaves: number,
  persistence: number,
  seed: number,
): number {
  let value = 0;
  let amplitude = 1;
  let amplitudeSum = 0;
  let frequency = startFrequency;

  for (let octave = 0; octave < octaves; octave++) {
    value += tiledValueNoise(x, y, textureSize, frequency, seed + octave * 1013) * amplitude;
    amplitudeSum += amplitude;
    amplitude *= persistence;
    frequency *= 2;
  }

  return value / amplitudeSum;
}

function tiledValueNoise(
  x: number,
  y: number,
  textureSize: number,
  frequency: number,
  seed: number,
): number {
  const sampleX = (x / textureSize) * frequency;
  const sampleY = (y / textureSize) * frequency;
  const x0 = Math.floor(sampleX);
  const y0 = Math.floor(sampleY);
  const tx = fade(sampleX - x0);
  const ty = fade(sampleY - y0);

  const top = mix(
    random2d(wrap(x0, frequency), wrap(y0, frequency), seed),
    random2d(wrap(x0 + 1, frequency), wrap(y0, frequency), seed),
    tx,
  );
  const bottom = mix(
    random2d(wrap(x0, frequency), wrap(y0 + 1, frequency), seed),
    random2d(wrap(x0 + 1, frequency), wrap(y0 + 1, frequency), seed),
    tx,
  );
  return mix(top, bottom, ty);
}

function random2d(x: number, y: number, seed: number): number {
  let value = Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495) ^ seed;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967295;
}

function fade(value: number): number {
  return value * value * (3 - 2 * value);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * amount;
}

function wrap(value: number, range: number): number {
  return ((value % range) + range) % range;
}

function toByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
