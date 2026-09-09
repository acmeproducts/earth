import { buildingInteriorUse, normalizeBuildingClass, type BuildingInteriorUse, type BuildingSource, type BuildingPolygon, type LonLat } from "./BuildingPlanner";

export interface BuildingUseContext {
  points: readonly { position: LonLat; properties: Readonly<Record<string, unknown>> }[];
  areas: readonly { polygon: BuildingPolygon; properties: Readonly<Record<string, unknown>> }[];
}

function containsRing(point: LonLat, ring: readonly LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
      point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function contains(point: LonLat, polygon: BuildingPolygon): boolean {
  return containsRing(point, polygon.outer) && !polygon.holes.some((hole) => containsRing(point, hole));
}

function contextUse(properties: Readonly<Record<string, unknown>>, point: boolean): BuildingInteriorUse | undefined {
  const tagged = buildingInteriorUse(properties);
  if (tagged) return tagged;
  const values = [properties.subclass, properties.class, properties.landuse, properties.amenity]
    .filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase().trim());
  if (point && values.some((value) => ["shop", "grocery", "clothes", "bakery", "books", "butcher", "convenience", "department_store", "mall"].includes(value))) return "shop";
  if (values.includes("retail")) return "shop";
  if (values.includes("commercial")) return "office";
  if (values.includes("industrial")) return "industrial";
  if (values.includes("residential")) return "residential";
  return undefined;
}

/** Conservative evidence hierarchy: mapped use, contained POIs, then enclosing land use.
 * Ambiguous POIs are left unresolved; nearby businesses are never assigned across a street.
 */
export function inferBuildingUse(source: BuildingSource, context: BuildingUseContext): BuildingSource {
  const tagged = buildingInteriorUse(source.properties);
  const mappedClass = normalizeBuildingClass(source.properties.class ?? source.properties.building);
  if (tagged && tagged !== "residential") return source;
  if (!tagged && mappedClass !== "generic") return source;
  const xs = source.polygon.outer.map((p) => p[0]), ys = source.polygon.outer.map((p) => p[1]);
  const west = Math.min(...xs), east = Math.max(...xs), south = Math.min(...ys), north = Math.max(...ys);
  const uses = new Set<BuildingInteriorUse>();
  for (const point of context.points) {
    const [x, y] = point.position;
    if (x < west || x > east || y < south || y > north || !contains(point.position, source.polygon)) continue;
    const use = contextUse(point.properties, true);
    if (use) uses.add(use);
  }
  if (uses.size > 1) return source;
  if (uses.size === 1) {
    const use = [...uses][0];
    if (tagged === "residential" && !["shop", "office", "medical"].includes(use)) return source;
    return { ...source, inferredUse: { use, source: "poi", groundFloorOnly: tagged === "residential" } };
  }
  if (tagged) return source;
  // Require the entire footprint (vertices and edge midpoints) inside the area.
  // This avoids assigning a campus or industrial zone to a building across its boundary.
  const samples = source.polygon.outer.flatMap((p, index, ring): LonLat[] => {
    const next = ring[(index + 1) % ring.length];
    return [p, [(p[0] + next[0]) / 2, (p[1] + next[1]) / 2]];
  });
  const areaUses = new Set<BuildingInteriorUse>();
  for (const area of context.areas) {
    const use = contextUse(area.properties, false);
    if (use && samples.every((point) => contains(point, area.polygon))) areaUses.add(use);
  }
  if (areaUses.size !== 1) return source;
  return { ...source, inferredUse: { use: [...areaUses][0], source: "landuse" } };
}
