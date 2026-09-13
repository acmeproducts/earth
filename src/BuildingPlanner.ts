import { hashString } from "./Random";

export type LonLat = [longitude: number, latitude: number];

export interface BuildingPolygon {
  outer: LonLat[];
  holes: LonLat[][];
}

/** Occupied cross-section between elevations relative to the building base. */
export interface BuildingHeightBand {
  minimumHeightMeters: number;
  heightMeters: number;
  footprints: BuildingPolygon[];
  roofs: BuildingPolygon[];
  soffits: BuildingPolygon[];
}

export interface BuildingSource {
  heightBands?: BuildingHeightBand[];
  /** Stable across application-tile rebuilds and independent of load order. */
  id: string;
  polygon: BuildingPolygon;
  properties: Readonly<Record<string, unknown>>;
  inferredUse?: { use: BuildingInteriorUse; source: "poi" | "landuse"; groundFloorOnly?: boolean };
}

export type BuildingDetailLevel = "far" | "detailed";
export type BuildingInteriorUse = "residential" | "shop" | "office" | "hotel" | "education" | "medical" | "warehouse" | "industrial" | "garage";

/** The stable, coarse use categories understood by the renderer. */
export type BuildingClass =
  | "residential"
  | "commercial"
  | "industrial"
  | "warehouse"
  | "garage"
  | "education"
  | "medical"
  | "religious"
  | "utility"
  | "generic";

export type BuildingRoofShape =
  | "flat"
  | "gabled"
  | "hipped"
  | "pyramidal"
  | "dome"
  | "onion"
  | "round"
  | "skillion"
  | "unknown";

/**
 * Semantic description shared by every building renderer. Geometry compilers
 * may omit detail, but they must not independently reinterpret the OSM source.
 */
export interface BuildingPlan {
  heightBands?: BuildingHeightBand[];
  id: string;
  footprint: BuildingPolygon;
  buildingClass: BuildingClass;
  interiorUse?: BuildingInteriorUse;
  groundFloorUse?: BuildingInteriorUse;
  interiorUseSource?: "tags" | "poi" | "landuse";
  heightMeters: number;
  minimumHeightMeters: number;
  levels?: number;
  roofHeightMeters?: number;
  roofShape: BuildingRoofShape;
  wallMaterial?: string;
  roofMaterial?: string;
  wallColor?: string;
  roofColor?: string;
  detailSeed: number;
}

const DEFAULT_BUILDING_HEIGHT_METERS = 3.1;

export function planBuilding(source: BuildingSource): BuildingPlan {
  const taggedUse = buildingInteriorUse(source.properties);
  const inference = source.inferredUse;
  const interiorUse = taggedUse ?? (inference?.groundFloorOnly ? undefined : inference?.use);
  const mappedClass = normalizeBuildingClass(source.properties.class ?? source.properties.building);
  const heightMeters = positiveNumber(source.properties.render_height) ??
    DEFAULT_BUILDING_HEIGHT_METERS;
  const minimumHeightMeters = Math.min(
    heightMeters,
    nonNegativeNumber(source.properties.render_min_height) ?? 0,
  );

  return {
    heightBands: source.heightBands,
    id: source.id,
    footprint: source.polygon,
    buildingClass: mappedClass === "generic" && interiorUse
      ? normalizeBuildingClass(interiorUse === "shop" ? "retail" : interiorUse) : mappedClass,
    interiorUse,
    groundFloorUse: inference?.groundFloorOnly ? inference.use : undefined,
    interiorUseSource: taggedUse ? "tags" : inference?.source,
    heightMeters,
    minimumHeightMeters,
    levels: positiveNumber(source.properties.levels),
    roofHeightMeters: positiveNumber(source.properties.roof_height),
    roofShape: roofShape(source.properties.roof_shape),
    wallMaterial: textProperty(source.properties.material),
    roofMaterial: textProperty(source.properties.roof_material),
    wallColor: colorProperty(
      source.properties.colour ??
      source.properties.color ??
      source.properties.building_colour ??
      source.properties.building_color,
    ),
    roofColor: colorProperty(
      source.properties.roof_colour ?? source.properties.roof_color,
    ),
    detailSeed: hashString(source.id),
  };
}

/** Use the tags supplied by the tile; no POI-to-building association is assumed. */
export function buildingInteriorUse(properties: BuildingSource["properties"]): BuildingPlan["interiorUse"] {
  const values = [properties["building:use"], properties.building, properties.subclass, properties.class].map(textProperty);
  const shop = textProperty(properties.shop), office = textProperty(properties.office);
  if (values.includes("hotel") || textProperty(properties.tourism) === "hotel") return "hotel";
  const amenity = textProperty(properties.amenity);
  for (const value of [...values, amenity, textProperty(properties.healthcare)]) {
    const category = normalizeBuildingClass(value);
    if (["education", "medical", "warehouse", "industrial", "garage"].includes(category)) return category as BuildingInteriorUse;
  }
  if ((shop && !["no", "vacant"].includes(shop)) || values.some((v) => v === "retail" || v === "supermarket")) return "shop";
  if ((office && office !== "no") || values.includes("office")) return "office";
  if (values.some((v) => normalizeBuildingClass(v) === "residential")) return "residential";
  if (values.includes("commercial")) return "office";
  return undefined;
}

/** Maps provider/OSM-specific values onto the small vocabulary used in-world. */
export function normalizeBuildingClass(value: unknown): BuildingClass {
  const normalized = textProperty(value);
  if (!normalized) return "generic";
  if (["residential", "house", "detached", "semidetached_house", "apartments",
    "bungalow", "cabin", "dormitory"].includes(normalized)) return "residential";
  if (["commercial", "retail", "office", "supermarket", "hotel"].includes(normalized)) {
    return "commercial";
  }
  if (["industrial", "factory", "manufacture"].includes(normalized)) return "industrial";
  if (["warehouse", "storage"].includes(normalized)) return "warehouse";
  if (["garage", "garages", "carport", "parking"].includes(normalized)) return "garage";
  if (["education", "school", "college", "university", "kindergarten"].includes(normalized)) {
    return "education";
  }
  if (["medical", "hospital", "clinic", "healthcare", "doctors"].includes(normalized)) return "medical";
  if (["church", "chapel", "mosque", "temple", "synagogue", "religious"].includes(normalized)) {
    return "religious";
  }
  if (["utility", "service", "transformer_tower"].includes(normalized)) return "utility";
  return "generic";
}

function roofShape(value: unknown): BuildingRoofShape {
  const shape = textProperty(value);
  switch (shape) {
    case "flat":
    case "gabled":
    case "hipped":
    case "pyramidal":
    case "dome":
    case "onion":
    case "round":
    case "skillion":
      return shape;
    default:
      return "unknown";
  }
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function textProperty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function colorProperty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}
