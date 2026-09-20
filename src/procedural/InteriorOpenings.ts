import { segmentsIntersect, type Opening2D, type Point2D } from "../buildings/FloorPlan";
import { overlappingSegment } from "../core/PolygonGeometry";

/** Inherited and generated doors can describe overlapping portions of one aperture. */
export function mergeDoorOpenings(openings: readonly Opening2D[]): Opening2D[] {
  const doors = openings.filter((opening) => opening.type === "door");
  if (!doors.length) return [];
  const span = (axis: "x" | "y") => Math.max(...doors.map(d => Math.max(d.start[axis], d.end[axis]))) -
    Math.min(...doors.map(d => Math.min(d.start[axis], d.end[axis])));
  const axis = span("x") >= span("y") ? "x" : "y";
  const minimum = (door: Opening2D) => Math.min(door.start[axis], door.end[axis]);
  const maximum = (door: Opening2D) => Math.max(door.start[axis], door.end[axis]);
  doors.sort((a, b) => minimum(a) - minimum(b));
  const result: Array<Opening2D | undefined> = [];
  const active: number[] = [];
  for (const opening of doors) {
    let merged = { ...opening };
    for (let index = 0; index < active.length;) {
      const other = result[active[index]]!;
      // A sweep along the wider axis avoids all-pairs work on large floor plans.
      if (maximum(other) < minimum(opening) - 1e-6) { active.splice(index, 1); continue; }
      if (!overlappingSegment(merged.start, merged.end, other.start, other.end)) { index++; continue; }
      const dx = other.end.x - other.start.x, dy = other.end.y - other.start.y;
      const points = [merged.start, merged.end, other.start, other.end]
        .sort((a, b) => (a.x - b.x) * dx + (a.y - b.y) * dy);
      merged = { ...other, start: points[0], end: points[3], fullHeight: merged.fullHeight || other.fullHeight };
      result[active[index]] = undefined;
      active.splice(index, 1);
      index = 0;
    }
    active.push(result.length);
    result.push(merged);
  }
  return result.filter((door): door is Opening2D => door !== undefined);
}

/** Cut only the doorway's span, including a short clearance at crossing partitions. */
export function wallDoorInterval(start: Point2D, end: Point2D, opening: Opening2D):
  { minimum: number; maximum: number } | undefined {
  if (opening.type !== "door") return undefined;
  const dx = end.x - start.x, dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-7) return undefined;
  const overlap = overlappingSegment(start, end, opening.start, opening.end);
  if (overlap) {
    const project = (p: Point2D) => ((p.x - start.x) * dx + (p.y - start.y) * dy) / length;
    return { minimum: Math.max(0, project(overlap[0])), maximum: Math.min(length, project(overlap[1])) };
  }
  if (!segmentsIntersect(start, end, opening.start, opening.end)) return undefined;
  const ox = opening.end.x - opening.start.x, oy = opening.end.y - opening.start.y;
  const cross = dx * oy - dy * ox;
  if (Math.abs(cross) < 1e-9) return undefined;
  const along = ((opening.start.x - start.x) * oy - (opening.start.y - start.y) * ox) / cross * length;
  return { minimum: Math.max(0, along - 0.35), maximum: Math.min(length, along + 0.35) };
}
