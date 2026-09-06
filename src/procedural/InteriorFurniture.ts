import { Mesh, Scene, VertexData } from "@babylonjs/core";
import type { ApartmentLayout } from "../ApartmentLayoutPlanner";
import { segmentsIntersect, type Point2D } from "../FloorPlan";
import { setBuildingSurface } from "./BuildingMaterial";

type FurnitureKind = "toilet" | "sink" | "stove" | "counter" | "fridge" | "dining" | "sofa" | "bookcase" | "painting";
export interface FurniturePlacement {
  kind: FurnitureKind;
  roomId: string;
  center: Point2D;
  along: Point2D;
  inward: Point2D;
  width: number;
  depth: number;
  footprint: Point2D[];
}
const sizes: Record<FurnitureKind, readonly [number, number]> = {
  toilet: [0.7, 0.85], sink: [0.8, 0.55], stove: [0.7, 0.75],
  counter: [1.15, 0.67], fridge: [0.72, 0.82], dining: [2.5, 2.3],
  sofa: [1.9, 0.85], bookcase: [0.85, 0.35], painting: [0.8, 0.12],
};
function distance(point: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}
function inside(point: Point2D, polygon: readonly Point2D[]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}
function segmentGap(a: Point2D, b: Point2D, c: Point2D, d: Point2D): number {
  return segmentsIntersect(a, b, c, d) ? 0 : Math.min(distance(a, c, d), distance(b, c, d), distance(c, a, b), distance(d, a, b));
}
function polygonGap(a: readonly Point2D[], b: readonly Point2D[]): number {
  if (inside(a[0], b) || inside(b[0], a)) return 0;
  return Math.min(...a.flatMap((p, i) => b.map((q, j) => segmentGap(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length]))));
}

/** Meter-space placement, independent of rendering and stable across interior reloads. */
export function planInteriorFurniture(layout: ApartmentLayout): FurniturePlacement[] {
  const result: FurniturePlacement[] = [];
  for (const room of layout.rooms) {
    const ring = room.polygon.outer;
    const center = { x: ring.reduce((s, p) => s + p.x, 0) / ring.length, y: ring.reduce((s, p) => s + p.y, 0) / ring.length };
    const kinds: FurnitureKind[] = room.type === "toilet" ? ["toilet", "sink", "painting"]
      : room.type === "kitchen" ? ["stove", "sink", "counter", "fridge", "dining", "painting"]
      : ["dining", "sofa", "bookcase", "painting"];
    for (const kind of kinds) {
      const [width, depth] = sizes[kind];
      const candidates: FurniturePlacement[] = [];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length < width + 0.4) continue;
        const along = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
        const sign = (center.x - a.x) * -along.y + (center.y - a.y) * along.x >= 0 ? 1 : -1;
        const inward = { x: -along.y * sign, y: along.x * sign };
        const add = (position: Point2D): void => {
          const footprint = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => ({
            x: position.x + along.x * x * width / 2 + inward.x * y * depth / 2,
            y: position.y + along.y * x * width / 2 + inward.y * y * depth / 2,
          }));
          candidates.push({ kind, roomId: room.id, center: position, along, inward, width, depth, footprint });
        };
        if (kind === "dining") add(center);
        for (const fraction of [0.5, 0.22, 0.78]) {
          add({ x: a.x + along.x * length * fraction + inward.x * (depth / 2 + 0.17),
            y: a.y + along.y * length * fraction + inward.y * (depth / 2 + 0.17) });
        }
      }
      const chosen = candidates.find((candidate) => {
        const footprint = candidate.footprint;
        if (!footprint.every((p) => inside(p, ring))) return false;
        if (footprint.some((p, i) => ring.some((q, j) => segmentGap(p, footprint[(i + 1) % 4], q, ring[(j + 1) % ring.length]) < 0.13))) return false;
        if (room.polygon.holes?.some((hole) => polygonGap(footprint, hole) < 0.13)) return false;
        if (layout.openings?.some((opening) => {
          if (opening.type === "window" && !["painting", "fridge", "bookcase"].includes(kind)) return false;
          return inside(opening.start, footprint) || footprint.some((p, i) =>
            segmentGap(p, footprint[(i + 1) % 4], opening.start, opening.end) < (opening.type === "door" ? 0.9 : 0.18));
        })) return false;
        return !result.some((other) => other.roomId === room.id && polygonGap(footprint, other.footprint) < 0.18);
      });
      if (chosen) result.push(chosen);
    }
  }
  return result;
}

const wood = [0.43, 0.26, 0.13], white = [0.88, 0.89, 0.85], dark = [0.075, 0.09, 0.10];
const metal = [0.48, 0.53, 0.55], blue = [0.20, 0.37, 0.43];

/** Build all props into one vertex-colored mesh, with no per-prop materials or draw calls. */
export function createInteriorFurniture(scene: Scene, placements: readonly FurniturePlacement[], elevation: number, metersPerUnit: number, height: number, seed: number): Mesh | undefined {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [], colors: number[] = [], uvs: number[] = [];
  for (const item of placements) {
    const box = (x: number, y: number, z: number, w: number, h: number, d: number, color: number[]): void => {
      if (y + h / 2 > height - 0.12) return;
      const data = VertexData.CreateBox({ width: w, height: h, depth: d });
      const offset = positions.length / 3;
      uvs.push(...data.uvs!);
      for (let i = 0; i < data.positions!.length; i += 3) {
        const px = data.positions![i] + x, py = data.positions![i + 1] + y, pz = data.positions![i + 2] + z;
        positions.push((item.center.x + item.along.x * px + item.inward.x * pz) / metersPerUnit,
          (elevation + py) / metersPerUnit, (item.center.y + item.along.y * px + item.inward.y * pz) / metersPerUnit);
        const nx = data.normals![i], ny = data.normals![i + 1], nz = data.normals![i + 2];
        normals.push(item.along.x * nx + item.inward.x * nz, ny, item.along.y * nx + item.inward.y * nz);
        colors.push(...color, 1);
      }
      // Opposite polygon windings produce reflected furniture frames.
      const reflected = item.along.x * item.inward.y - item.along.y * item.inward.x < 0;
      for (let i = 0; i < data.indices!.length; i += 3) {
        indices.push(offset + data.indices![i], offset + data.indices![i + (reflected ? 2 : 1)], offset + data.indices![i + (reflected ? 1 : 2)]);
      }
    };
    const legs = (x: number, z: number, w: number, d: number, h: number): void => {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(x + sx * (w / 2 - 0.06), h / 2, z + sz * (d / 2 - 0.06), 0.07, h, 0.07, wood);
    };
    switch (item.kind) {
      case "toilet":
        box(0, 0.2, 0.08, 0.3, 0.4, 0.44, white);
        box(0, 0.57, -0.29, 0.52, 0.62, 0.22, white);
        box(0, 0.42, 0.1, 0.53, 0.16, 0.59, white);
        box(0, 0.507, 0.1, 0.32, 0.018, 0.36, dark);
        box(0.15, 0.89, -0.29, 0.08, 0.025, 0.06, metal);
        break;
      case "sink":
        box(0, 0.4, 0, 0.7, 0.8, 0.48, wood);
        box(0, 0.84, 0, 0.8, 0.09, 0.55, white);
        box(0, 0.89, 0.02, 0.48, 0.02, 0.3, metal);
        box(0, 1, -0.2, 0.035, 0.25, 0.035, metal);
        box(0, 1.11, -0.13, 0.035, 0.035, 0.17, metal);
        break;
      case "stove":
        box(0, 0.44, 0, 0.7, 0.88, 0.65, white);
        box(0, 0.91, 0, 0.7, 0.06, 0.65, dark);
        for (const x of [-0.18, 0.18]) for (const z of [-0.16, 0.16]) {
          box(x, 0.95, z, 0.2, 0.025, 0.2, metal);
          box(x, 0.965, z, 0.12, 0.012, 0.12, dark);
        }
        box(0, 0.4, 0.33, 0.52, 0.42, 0.025, dark);
        box(0, 0.65, 0.35, 0.48, 0.035, 0.045, metal);
        for (const x of [-0.22, -0.07, 0.07, 0.22]) box(x, 0.79, 0.34, 0.045, 0.045, 0.04, dark);
        break;
      case "counter":
        box(0, 0.43, 0, 1.1, 0.86, 0.6, wood);
        box(0, 0.9, 0, 1.15, 0.08, 0.65, white);
        for (const x of [-0.28, 0.28]) box(x, 0.71, 0.31, 0.18, 0.025, 0.04, metal);
        break;
      case "fridge":
        box(0, 0.9, 0, 0.7, 1.8, 0.7, white);
        box(0, 1.3, 0.357, 0.68, 0.022, 0.015, dark);
        box(0.25, 1.08, 0.38, 0.035, 0.3, 0.05, metal);
        break;
      case "dining":
        box(0, 0.76, 0, 1.3, 0.09, 0.8, wood);
        legs(0, 0, 1.2, 0.7, 0.72);
        for (const x of [-0.43, 0.43]) for (const z of [-0.78, 0.78]) {
          box(x, 0.46, z, 0.4, 0.07, 0.4, wood);
          legs(x, z, 0.36, 0.36, 0.43);
          box(x, 0.75, z + Math.sign(z) * 0.18, 0.4, 0.53, 0.055, blue);
        }
        box(0, 0.835, 0, 0.32, 0.035, 0.24, white);
        break;
      case "sofa":
        box(0, 0.25, 0, 1.85, 0.36, 0.8, wood);
        box(0, 0.66, -0.3, 1.85, 0.62, 0.19, blue);
        for (const x of [-0.86, 0.86]) box(x, 0.49, 0, 0.17, 0.46, 0.8, blue);
        for (const x of [-0.41, 0.41]) box(x, 0.48, 0.06, 0.79, 0.18, 0.59, blue);
        break;
      case "bookcase":
        box(0, 0.88, -0.15, 0.85, 1.76, 0.04, wood);
        for (const x of [-0.39, 0.39]) box(x, 0.88, 0, 0.07, 1.76, 0.35, wood);
        for (const y of [0.08, 0.59, 1.1, 1.7]) {
          box(0, y, 0, 0.85, 0.055, 0.35, wood);
          if (y < 1.7) for (let b = 0; b < 5; b++) box(-0.29 + b * 0.13, y + 0.2, 0, 0.09, 0.34, 0.23, b % 2 ? blue : [0.58, 0.24, 0.16]);
        }
        break;
      case "painting": {
        const accent = Math.abs(seed + Math.round(item.center.x * 17 + item.center.y * 31)) % 3;
        box(0, 1.62, 0, 0.8, 0.65, 0.07, wood);
        box(0, 1.62, 0.041, 0.68, 0.53, 0.014, [0.78, 0.75, 0.62]);
        box(-0.12, 1.69, 0.051, 0.26, 0.27, 0.012, accent === 0 ? blue : [0.67, 0.34, 0.19]);
        box(0.13, 1.49, 0.053, 0.34, 0.18, 0.014, accent === 1 ? blue : [0.31, 0.43, 0.27]);
        break;
      }
    }
  }
  if (!positions.length) return undefined;
  const mesh = new Mesh("buildingFurniture", scene);
  mesh.setEnabled(false);
  const data = new VertexData();
  data.positions = positions; data.normals = normals; data.indices = indices; data.colors = colors; data.uvs = uvs;
  data.applyToMesh(mesh);
  mesh.useVertexColors = true;
  setBuildingSurface(mesh, "plaster");
  return mesh;
}
