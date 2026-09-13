import type { PlannedRoadPolygon } from "./RoadAndBuildingPlanner";

export const DIRT_ROAD_EDGE_KIND = "dirtRoadEdge";

/** Linear coordinates, interpolated before the fragment shader applies the fade. */
export function dirtRoadEdgeCoordinates(
  point: { x: number; z: number },
  road: PlannedRoadPolygon,
  metersPerUnit: number,
): [number, number, number] {
  const [start, end] = road.centerline;
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  const width = road.widthMeters / metersPerUnit;
  // Junction discs and bend wedges must not acquire their own transparent rim.
  // Very short pieces stay solid too, instead of becoming little faded spots.
  if (road.junctionArms || length <= width * 2 || width <= 0) return [0, 0, 0];
  const along = ((point.x - start.x) * dx + (point.z - start.z) * dz) / length;
  const across = ((point.x - start.x) * -dz + (point.z - start.z) * dx) / length;
  return [
    2 * across / width,
    (along - road.gradeRange[0] * length) / width,
    (road.gradeRange[1] * length - along) / width,
  ];
}

export const DIRT_ROAD_EDGE_ALPHA_GLSL = `
  float dirtAcross = 1.0 - abs(vDirtRoadEdge.x);
  float dirtSideAlpha = smoothstep(0.03, 0.33, dirtAcross);
  float dirtEndDistance = min(vDirtRoadEdge.y, vDirtRoadEdge.z);
  float dirtFadeStrength = smoothstep(0.15, 1.0, dirtEndDistance);
  result *= mix(1.0, dirtSideAlpha, dirtFadeStrength);
`;
