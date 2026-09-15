/** Returns a local frame with x running along the longest exterior wall. */
export function planningFrameForPolygon(points) {
  let longest;
  let length = 0;
  for (let index = 0; index < points.length; index++) {
    const [start, end] = canonicalEdge(points[index], points[(index + 1) % points.length]);
    const candidate = Math.hypot(end.x - start.x, end.y - start.y);
    if (candidate > length + 1e-7 ||
        (Math.abs(candidate - length) <= 1e-7 && (!longest || compareEdges([start, end], longest) < 0))) {
      longest = [start, end];
      length = candidate;
    }
  }
  const origin = longest?.[0] ?? { x: 0, y: 0 };
  const xAxis = longest && length > 1e-7
    ? { x: (longest[1].x - origin.x) / length, y: (longest[1].y - origin.y) / length }
    : { x: 1, y: 0 };
  return { origin, xAxis, yAxis: { x: -xAxis.y, y: xAxis.x } };
}

function canonicalEdge(first, second) {
  return comparePoints(first, second) <= 0 ? [first, second] : [second, first];
}

function compareEdges(first, second) {
  return comparePoints(first[0], second[0]) || comparePoints(first[1], second[1]);
}

function comparePoints(first, second) {
  return first.x - second.x || first.y - second.y;
}

export function pointInPlanningFrame(point, frame) {
  const delta = { x: point.x - frame.origin.x, y: point.y - frame.origin.y };
  return {
    x: delta.x * frame.xAxis.x + delta.y * frame.xAxis.y,
    y: delta.x * frame.yAxis.x + delta.y * frame.yAxis.y,
  };
}

export function pointFromPlanningFrame(point, frame) {
  return {
    x: frame.origin.x + point.x * frame.xAxis.x + point.y * frame.yAxis.x,
    y: frame.origin.y + point.x * frame.xAxis.y + point.y * frame.yAxis.y,
  };
}
