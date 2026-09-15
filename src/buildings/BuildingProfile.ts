import type { BuildingClass } from "./BuildingPlanner";

export interface BuildingProfile {
  /** Whether the near-field shell should be arranged as rooms or open volume. */
  interiorLayout: "rooms" | "open";
  /** Maximum floors we synthesize when mapped levels are absent or excessive. */
  maximumInteriorFloors: number;
  /** Whether the generated interior should receive a stair flight per level. */
  hasStairs: boolean;
  wall: string;
  roof: string;
}

const PROFILES: Readonly<Record<BuildingClass, BuildingProfile>> = {
  residential: { interiorLayout: "rooms", maximumInteriorFloors: 20, hasStairs: true, wall: "#d7d0c1", roof: "#655b52" },
  commercial: { interiorLayout: "rooms", maximumInteriorFloors: 20, hasStairs: true, wall: "#c4c8c5", roof: "#59636a" },
  industrial: { interiorLayout: "open", maximumInteriorFloors: 2, hasStairs: false, wall: "#aaa9a3", roof: "#59605f" },
  warehouse: { interiorLayout: "open", maximumInteriorFloors: 1, hasStairs: false, wall: "#b9b1a1", roof: "#6d665d" },
  garage: { interiorLayout: "open", maximumInteriorFloors: 1, hasStairs: false, wall: "#b7b8b2", roof: "#62645f" },
  education: { interiorLayout: "rooms", maximumInteriorFloors: 8, hasStairs: true, wall: "#d2c7a9", roof: "#665c54" },
  medical: { interiorLayout: "rooms", maximumInteriorFloors: 20, hasStairs: true, wall: "#d8d9d3", roof: "#697780" },
  religious: { interiorLayout: "open", maximumInteriorFloors: 3, hasStairs: false, wall: "#c8b9a3", roof: "#665649" },
  utility: { interiorLayout: "open", maximumInteriorFloors: 1, hasStairs: false, wall: "#9fa5a1", roof: "#555d5e" },
  generic: { interiorLayout: "rooms", maximumInteriorFloors: 20, hasStairs: true, wall: "#d0ccc2", roof: "#625b54" },
};

export function buildingProfile(buildingClass: BuildingClass): BuildingProfile {
  return PROFILES[buildingClass] ?? PROFILES.generic;
}
