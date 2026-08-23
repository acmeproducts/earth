import type { TerrainData } from "./TerrainData";

export interface TerrainLakePoint {
  x: number;
  z: number;
}

export interface TerrainLakeSeed extends TerrainLakePoint {
  sourceId: string;
}

export interface TerrainLakePolygon {
  sourceId?: string;
  outline: TerrainLakePoint[];
  holes: TerrainLakePoint[][];
  elevationMeters: number;
}

export interface TerrainLakePolygonOptions {
  meshWidth: number;
  meshDepth: number;
  /** Inland surfaces below this level are treated as ocean. */
  minimumElevationMeters?: number;
  /** Small allowance for elevation quantization around a nominally flat shore. */
  fillToleranceMeters?: number;
  seeds?: readonly TerrainLakeSeed[];
}

interface GridPoint {
  x: number;
  y: number;
}

interface WaterComponent {
  cells: number[];
  elevationMeters: number;
}

/**
 * Floods outward from connected classified-water seeds across every terrain
 * sample at or below the lake level, then traces the filled basin once.
 */
export async function buildTerrainLakePolygons(
  terrain: TerrainData,
  originalElevations: Float32Array,
  options: TerrainLakePolygonOptions,
  yieldControl?: () => Promise<void>,
): Promise<TerrainLakePolygon[]> {
  const mask = terrain.waterMask;
  if (!mask || mask.length !== terrain.width * terrain.height) return [];
  if (originalElevations.length !== mask.length) {
    throw new Error("Lake elevation source must match the terrain grid.");
  }

  const labels = new Int32Array(mask.length).fill(-1);
  const components: WaterComponent[] = [];
  for (let row = 0; row < terrain.height; row++) {
    for (let column = 0; column < terrain.width; column++) {
      const start = row * terrain.width + column;
      if (mask[start] === 0 || labels[start] >= 0) continue;
      const cells: number[] = [];
      const elevations: number[] = [];
      const stack = [start];
      const label = components.length;
      labels[start] = label;
      while (stack.length > 0) {
        const index = stack.pop()!;
        cells.push(index);
        elevations.push(originalElevations[index]);
        const x = index % terrain.width;
        const y = Math.floor(index / terrain.width);
        visit(x - 1, y);
        visit(x + 1, y);
        visit(x, y - 1);
        visit(x, y + 1);
      }
      components.push({ cells, elevationMeters: quantile(elevations, 0.25) });

      function visit(x: number, y: number): void {
        if (x < 0 || x >= terrain.width || y < 0 || y >= terrain.height) return;
        const index = y * terrain.width + x;
        if (mask![index] === 0 || labels[index] >= 0) return;
        labels[index] = label;
        stack.push(index);
      }
    }
    await yieldControl?.();
  }

  const minimumElevation = options.minimumElevationMeters ?? 1;
  const fillTolerance = options.fillToleranceMeters ?? 0.5;
  const polygons: TerrainLakePolygon[] = [];
  for (let label = 0; label < components.length; label++) {
    const component = components[label];
    const seed = seedForComponent(options.seeds, label, labels, terrain, options);
    const elevationMeters = seed
      ? sampleSeedElevation(seed, terrain, originalElevations, options)
      : component.elevationMeters;
    if (elevationMeters < minimumElevation) continue;
    const basin = fillBasin(
      component.cells,
      label,
      labels,
      originalElevations,
      elevationMeters + fillTolerance,
      terrain.width,
      terrain.height,
    );
    const loops = traceRegion(basin.cells, basin.membership, terrain.width, terrain.height)
      .map((loop) => gridLoopToScene(loop, terrain.width, terrain.height, options))
      .map(removeCollinearPoints)
      .filter((loop) => loop.length >= 3);
    if (loops.length === 0) continue;
    loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
    const outline = loops[0];
    if (signedArea(outline) < 0) outline.reverse();
    const holes = loops.slice(1).filter((loop) => pointInPolygon(loop[0], outline));
    for (const hole of holes) {
      if (signedArea(hole) > 0) hole.reverse();
    }
    polygons.push({
      sourceId: seed?.sourceId,
      outline,
      holes,
      elevationMeters,
    });
    await yieldControl?.();
  }
  return polygons;
}

function fillBasin(
  seeds: readonly number[],
  label: number,
  waterLabels: Int32Array,
  elevations: Float32Array,
  maximumElevation: number,
  width: number,
  height: number,
): { cells: number[]; membership: Uint8Array } {
  const membership = new Uint8Array(elevations.length);
  const cells: number[] = [];
  const stack = [...seeds];
  for (const seed of seeds) membership[seed] = 1;
  while (stack.length > 0) {
    const index = stack.pop()!;
    cells.push(index);
    const x = index % width;
    const y = Math.floor(index / width);
    visit(x - 1, y);
    visit(x + 1, y);
    visit(x, y - 1);
    visit(x, y + 1);
  }
  return { cells, membership };

  function visit(x: number, y: number): void {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const index = y * width + x;
    if (membership[index] !== 0 || elevations[index] > maximumElevation) return;
    // Do not consume a separately identified lake with a different level.
    if (waterLabels[index] >= 0 && waterLabels[index] !== label) return;
    membership[index] = 1;
    stack.push(index);
  }
}

function traceRegion(
  cells: readonly number[],
  membership: Uint8Array,
  width: number,
  height: number,
): GridPoint[][] {
  const edges = new Map<string, GridPoint[]>();
  const addEdge = (start: GridPoint, end: GridPoint): void => {
    const key = gridPointKey(start);
    const targets = edges.get(key);
    if (targets) targets.push(end);
    else edges.set(key, [end]);
  };
  const belongs = (x: number, y: number): boolean =>
    x >= 0 && x < width && y >= 0 && y < height && membership[y * width + x] !== 0;

  for (const index of cells) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (!belongs(x, y - 1)) addEdge({ x, y }, { x: x + 1, y });
    if (!belongs(x + 1, y)) addEdge({ x: x + 1, y }, { x: x + 1, y: y + 1 });
    if (!belongs(x, y + 1)) addEdge({ x: x + 1, y: y + 1 }, { x, y: y + 1 });
    if (!belongs(x - 1, y)) addEdge({ x, y: y + 1 }, { x, y });
  }

  const loops: GridPoint[][] = [];
  while (edges.size > 0) {
    const first = edges.entries().next().value as [string, GridPoint[]] | undefined;
    if (!first) break;
    const start = parseGridPoint(first[0]);
    const loop = [start];
    let current = takeEdge(edges, start);
    while (current && gridPointKey(current) !== gridPointKey(start)) {
      loop.push(current);
      current = takeEdge(edges, current);
    }
    if (current) loops.push(loop);
  }
  return loops;
}

function takeEdge(edges: Map<string, GridPoint[]>, start: GridPoint): GridPoint | undefined {
  const key = gridPointKey(start);
  const targets = edges.get(key);
  const target = targets?.pop();
  if (!targets || targets.length === 0) edges.delete(key);
  return target;
}

function gridLoopToScene(
  loop: readonly GridPoint[],
  width: number,
  height: number,
  options: Pick<TerrainLakePolygonOptions, "meshWidth" | "meshDepth">,
): TerrainLakePoint[] {
  return loop.map((point) => ({
    x: point.x / width * options.meshWidth - options.meshWidth / 2,
    z: options.meshDepth / 2 - point.y / height * options.meshDepth,
  }));
}

function removeCollinearPoints(points: TerrainLakePoint[]): TerrainLakePoint[] {
  if (points.length < 3) return points;
  return points.filter((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    return Math.abs(
      (point.x - previous.x) * (next.z - point.z) -
      (point.z - previous.z) * (next.x - point.x),
    ) > 1e-9;
  });
}

function seedForComponent(
  seeds: readonly TerrainLakeSeed[] | undefined,
  label: number,
  labels: Int32Array,
  terrain: TerrainData,
  options: Pick<TerrainLakePolygonOptions, "meshWidth" | "meshDepth">,
): TerrainLakeSeed | undefined {
  return seeds?.find((seed) => {
    const column = Math.floor((seed.x / options.meshWidth + 0.5) * terrain.width);
    const row = Math.floor((0.5 - seed.z / options.meshDepth) * terrain.height);
    return column >= 0 && column < terrain.width && row >= 0 && row < terrain.height &&
      labels[row * terrain.width + column] === label;
  });
}

function sampleSeedElevation(
  seed: TerrainLakeSeed,
  terrain: TerrainData,
  elevations: Float32Array,
  options: Pick<TerrainLakePolygonOptions, "meshWidth" | "meshDepth">,
): number {
  const u = Math.max(0, Math.min(1, seed.x / options.meshWidth + 0.5));
  const v = Math.max(0, Math.min(1, 0.5 - seed.z / options.meshDepth));
  const column = Math.round(u * (terrain.width - 1));
  const row = Math.round(v * (terrain.height - 1));
  return elevations[row * terrain.width + column];
}

function signedArea(points: readonly TerrainLakePoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.z - next.x * points[index].z;
  }
  return area / 2;
}

function pointInPolygon(point: TerrainLakePoint, polygon: readonly TerrainLakePoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    if (
      (a.z > point.z) !== (b.z > point.z) &&
      point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x
    ) inside = !inside;
  }
  return inside;
}

function quantile(values: readonly number[], amount: number): number {
  const selected = [...values];
  const index = Math.max(0, Math.min(
    selected.length - 1,
    Math.round((selected.length - 1) * amount),
  ));
  let left = 0;
  let right = selected.length - 1;
  while (left < right) {
    const pivot = selected[(left + right) >> 1];
    let lower = left;
    let upper = right;
    while (lower <= upper) {
      while (selected[lower] < pivot) lower++;
      while (selected[upper] > pivot) upper--;
      if (lower <= upper) {
        [selected[lower], selected[upper]] = [selected[upper], selected[lower]];
        lower++;
        upper--;
      }
    }
    if (index <= upper) right = upper;
    else if (index >= lower) left = lower;
    else break;
  }
  return selected[index];
}

function gridPointKey(point: GridPoint): string {
  return `${point.x}/${point.y}`;
}

function parseGridPoint(key: string): GridPoint {
  const [x, y] = key.split("/").map(Number);
  return { x, y };
}
