export function gridCell(x: number, y: number, width = Infinity, height = Infinity) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  return { x0, y0, x1: Math.min(x0 + 1, width - 1), y1: Math.min(y0 + 1, height - 1),
    fx: x - x0, fy: y - y0 };
}

export function bilinear(a: number, b: number, c: number, d: number, fx: number, fy: number): number {
  const top = a * (1 - fx) + b * fx;
  const bottom = c * (1 - fx) + d * fx;
  return top * (1 - fy) + bottom * fy;
}

export function sampleGridBilinear(
  values: ArrayLike<number>, width: number, height: number, x: number, y: number,
): number {
  const { x0, y0, x1, y1, fx, fy } = gridCell(x, y, width, height);
  return bilinear(values[y0 * width + x0], values[y0 * width + x1],
    values[y1 * width + x0], values[y1 * width + x1], fx, fy);
}

export function mapGridRange<T>(
  firstMin: number, firstMax: number, secondMin: number, secondMax: number,
  visit: (first: number, second: number) => T,
): T[] {
  const values: T[] = [];
  for (let first = firstMin; first <= firstMax; first++) {
    for (let second = secondMin; second <= secondMax; second++) values.push(visit(first, second));
  }
  return values;
}
