import polygonClipping from "polygon-clipping";
import { planBuilding, type BuildingHeightBand, type BuildingPolygon, type BuildingSource, type LonLat } from "./BuildingPlanner";

interface SourceGroupCacheNode {
  children: WeakMap<readonly BuildingSource[], SourceGroupCacheNode>;
  sources?: readonly BuildingSource[];
}

const sourceGroupCache: SourceGroupCacheNode = { children: new WeakMap() };

/** Reuse compositions across fresh tile arrays without retaining evicted provider sources. */
export function mergeBuildingSourceGroups(
  groups: readonly (readonly BuildingSource[])[],
): readonly BuildingSource[] {
  let node = sourceGroupCache;
  for (const group of groups) {
    let child = node.children.get(group);
    if (!child) {
      child = { children: new WeakMap() };
      node.children.set(group, child);
    }
    node = child;
  }
  // Order and group identity are significant: new decoded data must be recomposed.
  return node.sources ??= mergeOverlappingBuildings(groups.flat());
}

/** Merge positive-area overlaps before ownership, layouts, and geometry are planned. */
export function mergeOverlappingBuildings(sources: readonly BuildingSource[]): BuildingSource[] {
  const entries = sources.map((source, index) => {
    const points = source.polygon.outer;
    const plan = planBuilding(source);
    return {
      source, index, parent: index,
      minX: Math.min(...points.map((p) => p[0])),
      maxX: Math.max(...points.map((p) => p[0])),
      minY: Math.min(...points.map((p) => p[1])),
      maxY: Math.max(...points.map((p) => p[1])),
      bottom: plan.minimumHeightMeters, top: plan.heightMeters,
    };
  });
  const root = (index: number): number => {
    while (entries[index].parent !== index) {
      entries[index].parent = entries[entries[index].parent].parent;
      index = entries[index].parent;
    }
    return index;
  };
  const sorted = [...entries].sort((a, b) => a.minX - b.minX);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length && sorted[j].minX < a.maxX; j++) {
      const b = sorted[j];
      if (b.maxY <= a.minY || b.minY >= a.maxY || b.maxX <= a.minX ||
          b.bottom > a.top || a.bottom > b.top || root(a.index) === root(b.index)) continue;
      try {
        // Intersection excludes shared walls, point contacts, and courtyard interiors.
        if (polygonClipping.intersection(rings(a.source.polygon), rings(b.source.polygon)).length) {
          entries[root(b.index)].parent = root(a.index);
        }
      } catch {
        // A malformed provider polygon must not prevent the rest of the tile loading.
      }
    }
  }
  const groups = new Map<number, BuildingSource[]>();
  for (const entry of entries) {
    const key = root(entry.index);
    const group = groups.get(key) ?? [];
    group.push(entry.source);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    if (group.length === 1) return group;
    group.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    try {
      const polygons = polygonClipping.union(rings(group[0].polygon), ...group.slice(1).map((s) => rings(s.polygon)));
      if (polygons.length !== 1) return group;
      // Largest footprint supplies appearance/use; the tallest part supplies height/levels.
      const primary = group.reduce((a, b) => area(b.polygon) > area(a.polygon) ? b : a);
      const tallest = group.reduce((a, b) => planBuilding(b).heightMeters > planBuilding(a).heightMeters ? b : a);
      const ids = [...new Set(group.map((s) => s.id))];
      return [{
        ...primary,
        heightBands: buildHeightBands(group),
        id: ids.length === 1 ? ids[0] : `composite:${JSON.stringify(ids)}`,
        polygon: { outer: polygons[0][0], holes: polygons[0].slice(1) },
        properties: {
          ...primary.properties,
          render_height: planBuilding(tallest).heightMeters,
          render_min_height: Math.min(...group.map((s) => planBuilding(s).minimumHeightMeters)),
          levels: tallest.properties.levels,
        },
      }];
    } catch {
      return group;
    }
  });
}

function buildHeightBands(group: BuildingSource[]): BuildingHeightBand[] | undefined {
  const parts = group.flatMap((source) => source.heightBands ?? [{
    minimumHeightMeters: planBuilding(source).minimumHeightMeters,
    heightMeters: planBuilding(source).heightMeters,
    footprints: [source.polygon],
  }]);
  const heights = [...new Set(parts.flatMap((part) => [part.minimumHeightMeters, part.heightMeters]))].sort((a, b) => a - b);
  const sections = heights.slice(0, -1).map((bottom, index) => {
    const active = parts.filter((part) => part.minimumHeightMeters <= bottom && part.heightMeters >= heights[index + 1])
      .flatMap((part) => part.footprints.map(rings));
    return active.length ? polygonClipping.union(active[0], ...active.slice(1)) : [];
  });
  const polygons = (section: LonLat[][][]): BuildingPolygon[] => section.map(([outer, ...holes]) => ({ outer, holes }));
  // A nested shorter part may introduce a height without changing the shell.
  // Keep the existing detailed renderer (including interiors) for uniform volumes.
  if (sections.every((section) => JSON.stringify(section) === JSON.stringify(sections[0]))) return undefined;
  return sections.flatMap((section, index): BuildingHeightBand[] => section.length ? [{
    minimumHeightMeters: heights[index],
    heightMeters: heights[index + 1],
    footprints: polygons(section),
    roofs: polygons(polygonClipping.difference(section, sections[index + 1] ?? [])),
    soffits: polygons(polygonClipping.difference(section, sections[index - 1] ?? [])),
  }] : []);
}

function rings(polygon: BuildingPolygon): LonLat[][] {
  return [polygon.outer, ...polygon.holes];
}

function area(polygon: BuildingPolygon): number {
  const ringArea = (ring: LonLat[]) => {
    if (ring.length < 3) return 0;
    const [x, y] = ring[0];
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      sum += (a[0] - x) * (b[1] - y) - (b[0] - x) * (a[1] - y);
    }
    return Math.abs(sum) / 2;
  };
  return ringArea(polygon.outer) - polygon.holes.reduce((sum, hole) => sum + ringArea(hole), 0);
}
