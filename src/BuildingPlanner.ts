import { hashString } from "./Random";

export type LonLat = [longitude: number, latitude: number];

export interface BuildingPolygon {
  outer: LonLat[];
  holes: LonLat[][];
}

export interface BuildingSource {
  /** Stable across application-tile rebuilds and independent of load order. */
  id: string;
  polygon: BuildingPolygon;
  properties: Readonly<Record<string, unknown>>;
}

export type BuildingDetailLevel = "far" | "detailed";

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
  id: string;
  footprint: BuildingPolygon;
  buildingClass: BuildingClass;
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
  const heightMeters = positiveNumber(source.properties.render_height) ??
    DEFAULT_BUILDING_HEIGHT_METERS;
  const minimumHeightMeters = Math.min(
    heightMeters,
    nonNegativeNumber(source.properties.render_min_height) ?? 0,
  );

  return {
    id: source.id,
    footprint: source.polygon,
    buildingClass: normalizeBuildingClass(source.properties.class),
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
  if (["garage", "carport", "parking"].includes(normalized)) return "garage";
  if (["school", "college", "university", "kindergarten"].includes(normalized)) {
    return "education";
  }
  if (["hospital", "clinic", "healthcare"].includes(normalized)) return "medical";
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
