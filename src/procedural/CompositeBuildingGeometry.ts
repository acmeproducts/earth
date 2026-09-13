import earcut from "earcut";
import type { BuildingHeightBand, BuildingPolygon, LonLat } from "../BuildingPlanner";

type Point = { x: number; z: number };

/** Exterior faces only: band interfaces have already been subtracted by the planner. */
export function compositeBuildingGeometry(
  bands: readonly BuildingHeightBand[],
  project: (point: LonLat) => Point,
  elevation: (height: number) => number,
  showRoofs = true,
  showWalls = true,
): { positions: number[]; normals: number[]; indices: number[] } {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const triangle = (a: number[], b: number[], c: number[]) => {
    // Babylon uses the negative cross product for its left-handed face normals.
    const u = b.map((v, i) => v - a[i]), v = c.map((value, i) => value - a[i]);
    const normal = [u[2] * v[1] - u[1] * v[2], u[0] * v[2] - u[2] * v[0], u[1] * v[0] - u[0] * v[1]];
    const length = Math.hypot(...normal);
    if (length < 1e-12) return;
    const start = positions.length / 3;
    positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) normals.push(...normal.map((value) => value / length));
    indices.push(start, start + 1, start + 2);
  };
  const ring = (source: LonLat[], outer: boolean) => {
    const points = source.map(project);
    if (points.length > 1 && points[0].x === points[points.length - 1].x && points[0].z === points[points.length - 1].z) points.pop();
    const area = points.reduce((sum, a, i) => {
      const b = points[(i + 1) % points.length];
      return sum + a.x * b.z - b.x * a.z;
    }, 0);
    if ((area > 0) !== outer) points.reverse();
    return points;
  };
  const cap = (polygon: BuildingPolygon, y: number, upward: boolean) => {
    const loops = [ring(polygon.outer, true), ...polygon.holes.map((hole) => ring(hole, false))];
    const points: Point[] = [], holes: number[] = [];
    for (let i = 0; i < loops.length; i++) {
      if (i > 0) holes.push(points.length);
      points.push(...loops[i]);
    }
    const faces = earcut(points.flatMap((p) => [p.x, p.z]), holes);
    for (let i = 0; i < faces.length; i += 3) {
      const [a, b, c] = faces.slice(i, i + 3).map((index) => [points[index].x, y, points[index].z]);
      if (upward) triangle(a, b, c);
      else triangle(c, b, a);
    }
  };
  for (const band of bands) {
    const bottom = elevation(band.minimumHeightMeters), top = elevation(band.heightMeters);
    for (const polygon of showWalls ? band.footprints : []) {
      for (const loop of [ring(polygon.outer, true), ...polygon.holes.map((hole) => ring(hole, false))]) {
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i], b = loop[(i + 1) % loop.length];
          triangle([a.x, bottom, a.z], [b.x, bottom, b.z], [b.x, top, b.z]);
          triangle([a.x, bottom, a.z], [b.x, top, b.z], [a.x, top, a.z]);
        }
      }
    }
    if (showRoofs) for (const roof of band.roofs) cap(roof, top, true);
    for (const soffit of band.soffits) cap(soffit, bottom, false);
  }
  return { positions, normals, indices };
}
