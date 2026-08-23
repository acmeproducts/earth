import type { BuildingPlan, LonLat } from "./BuildingPlanner";

export type BuildingWindowRegion =
  | "nordic"
  | "mediterranean"
  | "arid"
  | "tropical"
  | "east-asian"
  | "north-american"
  | "continental";

export interface BuildingWindowStyle {
  id: string;
  region: BuildingWindowRegion;
  widthMeters: number;
  heightMeters: number;
  sillMeters: number;
  baySpacingMeters: number;
  blankBayChance: number;
  recessMeters: number;
  frameWidthMeters: number;
  verticalBars: readonly number[];
  horizontalBars: readonly number[];
  glass: readonly [number, number, number];
}

interface WindowStyleTemplate extends Omit<BuildingWindowStyle, "region" | "widthMeters" | "heightMeters"> {
  widthMeters: readonly [number, number];
  heightMeters: readonly [number, number];
}

const STYLES: Readonly<Record<string, WindowStyleTemplate>> = {
  "nordic-casement": {
    id: "nordic-casement", widthMeters: [1.08, 1.3], heightMeters: [1.42, 1.62],
    sillMeters: 0.72, baySpacingMeters: 2.35, blankBayChance: 0.05, recessMeters: 0.03,
    frameWidthMeters: 0.065, verticalBars: [0.5], horizontalBars: [], glass: [0.2, 0.34, 0.4],
  },
  "nordic-paned": {
    id: "nordic-paned", widthMeters: [1.25, 1.48], heightMeters: [1.32, 1.52],
    sillMeters: 0.76, baySpacingMeters: 2.55, blankBayChance: 0.07, recessMeters: 0.04,
    frameWidthMeters: 0.055, verticalBars: [0.5], horizontalBars: [0.52], glass: [0.22, 0.36, 0.42],
  },
  "mediterranean-tall": {
    id: "mediterranean-tall", widthMeters: [0.86, 1.08], heightMeters: [1.55, 1.82],
    sillMeters: 0.58, baySpacingMeters: 2.25, blankBayChance: 0.08, recessMeters: 0.1,
    frameWidthMeters: 0.06, verticalBars: [0.5], horizontalBars: [], glass: [0.18, 0.29, 0.33],
  },
  "mediterranean-transom": {
    id: "mediterranean-transom", widthMeters: [1.05, 1.28], heightMeters: [1.48, 1.72],
    sillMeters: 0.62, baySpacingMeters: 2.45, blankBayChance: 0.1, recessMeters: 0.08,
    frameWidthMeters: 0.06, verticalBars: [], horizontalBars: [0.72], glass: [0.19, 0.31, 0.35],
  },
  "arid-recessed": {
    id: "arid-recessed", widthMeters: [0.72, 0.94], heightMeters: [0.9, 1.12],
    sillMeters: 1.02, baySpacingMeters: 2.9, blankBayChance: 0.2, recessMeters: 0.16,
    frameWidthMeters: 0.055, verticalBars: [], horizontalBars: [], glass: [0.16, 0.25, 0.27],
  },
  "tropical-louvered": {
    id: "tropical-louvered", widthMeters: [1.42, 1.72], heightMeters: [1.02, 1.2],
    sillMeters: 0.86, baySpacingMeters: 2.65, blankBayChance: 0.06, recessMeters: 0.05,
    frameWidthMeters: 0.045, verticalBars: [], horizontalBars: [0.25, 0.5, 0.75], glass: [0.16, 0.34, 0.34],
  },
  "tropical-broad": {
    id: "tropical-broad", widthMeters: [1.58, 1.9], heightMeters: [1.08, 1.28],
    sillMeters: 0.8, baySpacingMeters: 2.9, blankBayChance: 0.05, recessMeters: 0.04,
    frameWidthMeters: 0.055, verticalBars: [0.5], horizontalBars: [], glass: [0.17, 0.36, 0.37],
  },
  "east-asian-grid": {
    id: "east-asian-grid", widthMeters: [1.38, 1.68], heightMeters: [1.16, 1.38],
    sillMeters: 0.78, baySpacingMeters: 2.65, blankBayChance: 0.08, recessMeters: 0.05,
    frameWidthMeters: 0.045, verticalBars: [0.333, 0.667], horizontalBars: [0.5], glass: [0.19, 0.33, 0.36],
  },
  "american-picture": {
    id: "american-picture", widthMeters: [1.55, 1.92], heightMeters: [1.12, 1.36],
    sillMeters: 0.82, baySpacingMeters: 3.05, blankBayChance: 0.06, recessMeters: 0.03,
    frameWidthMeters: 0.06, verticalBars: [], horizontalBars: [], glass: [0.2, 0.35, 0.4],
  },
  "american-sash": {
    id: "american-sash", widthMeters: [1.08, 1.34], heightMeters: [1.32, 1.55],
    sillMeters: 0.76, baySpacingMeters: 2.55, blankBayChance: 0.07, recessMeters: 0.04,
    frameWidthMeters: 0.065, verticalBars: [], horizontalBars: [0.5], glass: [0.21, 0.35, 0.4],
  },
  "continental-casement": {
    id: "continental-casement", widthMeters: [1.12, 1.42], heightMeters: [1.28, 1.52],
    sillMeters: 0.78, baySpacingMeters: 2.55, blankBayChance: 0.08, recessMeters: 0.05,
    frameWidthMeters: 0.06, verticalBars: [0.5], horizontalBars: [], glass: [0.2, 0.34, 0.39],
  },
  "continental-paned": {
    id: "continental-paned", widthMeters: [1.22, 1.48], heightMeters: [1.25, 1.48],
    sillMeters: 0.8, baySpacingMeters: 2.7, blankBayChance: 0.09, recessMeters: 0.06,
    frameWidthMeters: 0.05, verticalBars: [0.5], horizontalBars: [0.5], glass: [0.2, 0.33, 0.38],
  },
};

const REGION_STYLES: Readonly<Record<BuildingWindowRegion, readonly string[]>> = {
  nordic: ["nordic-casement", "nordic-casement", "nordic-paned"],
  mediterranean: ["mediterranean-tall", "mediterranean-tall", "mediterranean-transom"],
  arid: ["arid-recessed", "arid-recessed", "mediterranean-tall"],
  tropical: ["tropical-louvered", "tropical-louvered", "tropical-broad"],
  "east-asian": ["east-asian-grid", "east-asian-grid", "continental-casement"],
  "north-american": ["american-picture", "american-sash", "american-sash"],
  continental: ["continental-casement", "continental-paned", "american-sash"],
};

/** Picks one geographically biased window language and keeps it stable per building. */
export function buildingWindowStyle(plan: BuildingPlan): BuildingWindowStyle {
  const [longitude, latitude] = footprintCenter(plan.footprint.outer);
  const region = windowRegionAt(longitude, latitude);
  const palette = REGION_STYLES[region];
  const selection = seededUnit(plan.detailSeed ^ 0x621bca1d);
  const template = STYLES[palette[Math.min(palette.length - 1, Math.floor(selection * palette.length))]];
  const proportion = seededUnit(plan.detailSeed ^ 0x2c1b3c6d);
  return {
    ...template,
    region,
    widthMeters: interpolate(template.widthMeters, proportion),
    heightMeters: interpolate(template.heightMeters, seededUnit(plan.detailSeed ^ 0x53a8f9d1)),
  };
}

export function windowRegionAt(longitude: number, latitude: number): BuildingWindowRegion {
  if (latitude >= 54 && latitude <= 72 && longitude >= -25 && longitude <= 45) return "nordic";
  if (latitude >= 30 && latitude <= 47 && longitude >= -12 && longitude <= 45) return "mediterranean";
  if (latitude >= 18 && latitude <= 54 && longitude >= 95 && longitude <= 150) return "east-asian";
  if (latitude >= 24 && latitude <= 60 && longitude >= -130 && longitude <= -55) return "north-american";
  if (latitude >= 12 && latitude <= 34 && longitude >= -20 && longitude <= 65) return "arid";
  if (Math.abs(latitude) <= 24) return "tropical";
  return "continental";
}

function footprintCenter(points: readonly LonLat[]): LonLat {
  const count = points.length > 1 && samePoint(points[0], points[points.length - 1])
    ? points.length - 1
    : points.length;
  if (count === 0) return [0, 0];
  let longitude = 0;
  let latitude = 0;
  for (let index = 0; index < count; index++) {
    longitude += points[index][0];
    latitude += points[index][1];
  }
  return [longitude / count, latitude / count];
}

function samePoint(a: LonLat, b: LonLat): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function interpolate(range: readonly [number, number], amount: number): number {
  return range[0] + (range[1] - range[0]) * amount;
}

function seededUnit(seed: number): number {
  let value = seed | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
}
