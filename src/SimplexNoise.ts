/** Deterministic seeded 2D simplex noise with output approximately in [-1, 1]. */
export class SimplexNoise2D {
  private readonly permutation = new Uint8Array(512);

  constructor(seed: number) {
    const values = Array.from({ length: 256 }, (_, index) => index);
    const random = mulberry32(seed);
    for (let index = values.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(random() * (index + 1));
      [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
    }
    for (let index = 0; index < this.permutation.length; index++) {
      this.permutation[index] = values[index & 255];
    }
  }

  sample(x: number, y: number): number {
    const skew = (x + y) * 0.3660254037844386;
    const cellX = Math.floor(x + skew);
    const cellY = Math.floor(y + skew);
    const unskew = (cellX + cellY) * 0.21132486540518713;
    const localX = x - (cellX - unskew);
    const localY = y - (cellY - unskew);
    const stepX = localX > localY ? 1 : 0;
    const stepY = localX > localY ? 0 : 1;
    const middleX = localX - stepX + 0.21132486540518713;
    const middleY = localY - stepY + 0.21132486540518713;
    const farX = localX - 1 + 0.42264973081037427;
    const farY = localY - 1 + 0.42264973081037427;
    const wrappedX = cellX & 255;
    const wrappedY = cellY & 255;
    const gradient0 = this.permutation[wrappedX + this.permutation[wrappedY]] % 12;
    const gradient1 = this.permutation[
      wrappedX + stepX + this.permutation[wrappedY + stepY]
    ] % 12;
    const gradient2 = this.permutation[wrappedX + 1 + this.permutation[wrappedY + 1]] % 12;

    return 70 * (
      contribution(gradient0, localX, localY) +
      contribution(gradient1, middleX, middleY) +
      contribution(gradient2, farX, farY)
    );
  }
}

const GRADIENTS: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [1, 0], [-1, 0],
  [0, 1], [0, -1], [0, 1], [0, -1],
];

function contribution(gradientIndex: number, x: number, y: number): number {
  let attenuation = 0.5 - x * x - y * y;
  if (attenuation <= 0) return 0;
  attenuation *= attenuation;
  const gradient = GRADIENTS[gradientIndex];
  return attenuation * attenuation * (gradient[0] * x + gradient[1] * y);
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
