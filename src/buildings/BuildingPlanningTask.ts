import { pointOnSegment2D, polygonArea } from "../core/PolygonGeometry";
import { planBuildingLayout, type BuildingLayout } from "./BuildingLayoutPlanner";
import { MINIMUM_ROOM_AREA_SQUARE_METERS, planApartmentLayout, type ApartmentLayout } from "./ApartmentLayoutPlanner";
import type { BuildingPlan } from "./BuildingPlanner";
import type { Opening2D, Point2D } from "./FloorPlan";
import { planningFrameForPolygon } from "../core/PlanningFrame.mjs";
import { unitFromSeed } from "../core/Random";
import type { InteriorPlanningAttempt } from "../procedural/BuildingRendererTypes";

export type BuildingPlanningInput =
  | { kind: "building"; input: Parameters<typeof planBuildingLayout>[0] }
  | { kind: "apartments"; building: BuildingLayout; facadeOpenings: readonly Opening2D[];
      seed: number; use: NonNullable<BuildingPlan["interiorUse"]> };
export type ApartmentPlanningResult = { apartments: ApartmentLayout[]; failure?: string };
export type BuildingPlanningResult = InteriorPlanningAttempt | ApartmentPlanningResult;

export function runBuildingPlanning(input: BuildingPlanningInput): BuildingPlanningResult {
  if (input.kind === "apartments") {
    return planInteriorApartments(input.building, input.facadeOpenings, input.seed, input.use);
  }
  try {
    return { input: input.input, interior: { building: planBuildingLayout(input.input), apartments: [] } };
  } catch (error) {
    // Preserve the existing open-interior fallback for invalid footprints.
    return { input: input.input, failure: errorMessage(error) };
  }
}

export function runBuildingPlanningTask(input: BuildingPlanningInput) {
  const startTimeMilliseconds = performance.now();
  const result = runBuildingPlanning(input);
  return { result, timeOrigin: performance.timeOrigin, timings: [{
    stage: `building ${input.kind} layout planning`, startTimeMilliseconds,
    durationMilliseconds: performance.now() - startTimeMilliseconds,
  }] };
}
export type BuildingPlanningOutput = ReturnType<typeof runBuildingPlanningTask>;

function planInteriorApartments(building: BuildingLayout, facadeOpenings: readonly Opening2D[],
  seed: number, use: NonNullable<BuildingPlan["interiorUse"]>,
): { apartments: ApartmentLayout[]; failure?: string } {
  if (use === "residential" || use === "hotel") return planApartmentLayouts(building, facadeOpenings, seed);
  return { apartments: building.rooms.filter((room) => room.type === "apartment").map((room) => ({
    boundary: room.polygon, rooms: [{ id: room.id, type: "room", polygon: room.polygon }],
    openings: [...(building.openings ?? []), ...facadeOpenings]
      .filter((opening) => openingTouchesBoundary(opening, room.polygon.outer)),
  })) };
}

function planApartmentLayouts(
  building: BuildingLayout,
  facadeOpenings: readonly Opening2D[],
  buildingSeed: number,
): { apartments: ApartmentLayout[]; failure?: string } {
  const failures: string[] = [];
  const planningFrame = planningFrameForPolygon(building.boundary.outer);
  const apartments = building.rooms
    .filter((room) => room.type === "apartment")
    .flatMap((room, apartmentIndex) => {
      try {
        return [planApartmentLayout({
          apartmentPolygon: room.polygon,
          planningFrame,
          minimumRoomAreaSquareMeters: apartmentRoomAreaTarget(
            buildingSeed,
            apartmentIndex,
            room.polygon,
          ),
          openings: [...(building.openings ?? []), ...facadeOpenings]
            .filter((opening) => openingTouchesBoundary(opening, room.polygon.outer)),
        })];
      } catch (error) {
        failures.push(`${room.id}: ${errorMessage(error)}`);
        return [];
      }
    });
  return {
    apartments,
    failure: failures.length > 0
      ? `Apartment planning failed for ${failures.join("; ")}`
      : undefined,
  };
}

function apartmentRoomAreaTarget(
  buildingSeed: number,
  apartmentIndex: number,
  apartmentPolygon: BuildingLayout["rooms"][number]["polygon"],
): number {
  // Aim for four usable rooms before increasing their size. Keep variation
  // deterministic so rebuilding an apartment preserves its layout.
  const variation = unitFromSeed(buildingSeed ^ (apartmentIndex * 0x1f123bb5) ^ 0x3c6ef372);
  const minimum = MINIMUM_ROOM_AREA_SQUARE_METERS;
  const maximum = Math.max(minimum, Math.min(14, polygonArea(apartmentPolygon.outer) / 4));
  return minimum + variation * (maximum - minimum);
}

export function openingTouchesBoundary(opening: Opening2D, polygon: readonly Point2D[]): boolean {
  const center = {
    x: (opening.start.x + opening.end.x) / 2,
    y: (opening.start.y + opening.end.y) / 2,
  };
  return polygon.some((start, index) =>
    pointOnSegment2D(center, start, polygon[(index + 1) % polygon.length])
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
