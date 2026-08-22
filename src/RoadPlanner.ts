export type RoadSurface = "paved" | "unpaved";
export type RoadVisualStyle = RoadSurface | "marked" | "pedestrian";

export interface RoadPlan {
  widthMeters: number;
  surface: RoadSurface;
  visualStyle: RoadVisualStyle;
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

/** Converts provider road attributes into one renderer-independent description. */
export function planRoad(properties: Readonly<Record<string, unknown>>): RoadPlan | undefined {
  const roadClass = text(properties.class);
  if (!roadClass) return undefined;
  const baseWidth = CLASS_WIDTH_METERS[roadClass];
  if (!baseWidth) return undefined;

  const subclass = text(properties.subclass);
  const service = text(properties.service);
  const widthMeters = roadClass === "path" && subclass
    ? PATH_WIDTH_METERS[subclass] ?? baseWidth
    : roadClass === "service" && service
      ? SERVICE_WIDTH_METERS[service] ?? baseWidth
      : baseWidth;
  const mappedSurface = text(properties.surface);
  const surface: RoadSurface = mappedSurface === "unpaved" ||
      (mappedSurface !== "paved" && (
        roadClass === "track" ||
        (roadClass === "path" && !PAVED_PATHS.has(subclass ?? ""))
      ))
    ? "unpaved"
    : "paved";
  const visualStyle: RoadVisualStyle = surface === "unpaved"
    ? "unpaved"
    : roadClass === "path" || subclass === "pedestrian"
      ? "pedestrian"
      : MARKED_CLASSES.has(roadClass)
        ? "marked"
        : "paved";

  return {
    widthMeters,
    surface,
    visualStyle,
    isTunnel: text(properties.brunnel) === "tunnel",
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}
