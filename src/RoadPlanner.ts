export type RoadSurface = "paved" | "unpaved";
export type RoadVisualStyle = RoadSurface | "marked" | "pedestrian" | "ford";
export type RoadStructure = "surface" | "bridge" | "tunnel" | "ford";

export interface RoadPlan {
  roadClass: string;
  widthMeters: number;
  shoulderWidthMeters: number;
  surface: RoadSurface;
  visualStyle: RoadVisualStyle;
  structure: RoadStructure;
  layer: number;
  isTunnel: boolean;
}

const CLASS_WIDTH_METERS: Readonly<Record<string, number>> = {
  motorway: 10,
  trunk: 9,
  primary: 8,
  secondary: 7,
  tertiary: 6,
  minor: 4,
  service: 3,
  track: 2.4,
  path: 1.2,
};

const PATH_WIDTH_METERS: Readonly<Record<string, number>> = {
  bridleway: 1.8,
  corridor: 1.8,
  cycleway: 2.2,
  footway: 1.5,
  path: 1.2,
  pedestrian: 3,
  platform: 2.5,
  steps: 1.6,
};

const SERVICE_WIDTH_METERS: Readonly<Record<string, number>> = {
  alley: 3,
  driveway: 2.8,
  parking_aisle: 3.4,
};

const MARKED_CLASSES = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);
const PAVED_PATHS = new Set(["corridor", "cycleway", "pedestrian", "platform", "steps"]);

const CLASS_SHOULDER_WIDTH_METERS: Readonly<Record<string, number>> = {
  motorway: 2.5,
  trunk: 2.25,
  primary: 1.75,
  secondary: 1.5,
  tertiary: 1.25,
  minor: 0.9,
  service: 0.65,
  track: 0.55,
  path: 0.3,
};

/** Converts provider road attributes into one renderer-independent description. */
export function planRoad(properties: Readonly<Record<string, unknown>>): RoadPlan | undefined {
  const mappedClass = text(properties.class);
  if (!mappedClass) return undefined;
  const isConstruction = mappedClass.endsWith("_construction");
  const roadClass = isConstruction
    ? mappedClass.slice(0, -"_construction".length)
    : mappedClass;
  const baseWidth = CLASS_WIDTH_METERS[roadClass];
  if (!baseWidth) return undefined;

  const subclass = text(properties.subclass);
  const service = text(properties.service);
  const mappedWidth = roadClass === "path" && subclass
    ? PATH_WIDTH_METERS[subclass] ?? baseWidth
    : roadClass === "service" && service
      ? SERVICE_WIDTH_METERS[service] ?? baseWidth
      : baseWidth;
  const widthMeters = truthy(properties.ramp) ? mappedWidth * 0.72 : mappedWidth;
  const mappedSurface = text(properties.surface);
  const surface: RoadSurface = isConstruction || mappedSurface === "unpaved" ||
      (mappedSurface !== "paved" && (
        roadClass === "track" ||
        (roadClass === "path" && !PAVED_PATHS.has(subclass ?? ""))
      ))
    ? "unpaved"
    : "paved";
  const brunnel = text(properties.brunnel);
  const structure: RoadStructure = brunnel === "bridge"
    ? "bridge"
    : brunnel === "tunnel"
      ? "tunnel"
      : brunnel === "ford"
        ? "ford"
        : "surface";
  const visualStyle: RoadVisualStyle = structure === "ford"
    ? "ford"
    : surface === "unpaved"
    ? "unpaved"
    : roadClass === "path" || subclass === "pedestrian"
      ? "pedestrian"
      : MARKED_CLASSES.has(roadClass)
        ? "marked"
        : "paved";

  return {
    roadClass,
    widthMeters,
    shoulderWidthMeters: CLASS_SHOULDER_WIDTH_METERS[roadClass],
    surface,
    visualStyle,
    structure,
    layer: numeric(properties.layer) ?? 0,
    isTunnel: structure === "tunnel",
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function numeric(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}
