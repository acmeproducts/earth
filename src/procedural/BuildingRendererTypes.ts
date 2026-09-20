import type { BaseTexture, Color3, Mesh, TransformNode, Vector3 } from "@babylonjs/core";
import type { BuildingPlan, BuildingPolygon } from "../buildings/BuildingPlanner";
import type { BuildingLayout } from "../buildings/BuildingLayoutPlanner";
import type { ApartmentLayout } from "../buildings/ApartmentLayoutPlanner";
import type { Opening2D, Point2D } from "../buildings/FloorPlan";
import type { BuildingSurface } from "./BuildingMaterial";
import type { SharedValueMap } from "../core/OwnedValueCache";
import type { RoofAccess } from "./RooftopEquipment";

export interface BuildingRenderOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  skyReflection?: BaseTexture | null;
  showRoofs?: boolean;
  /** Render the complete source polygon when its streamed tile owns it. */
  renderWholeBuildingFootprints?: boolean;
  /** Stable terrain-pad heights keyed by source building ID. */
  sharedBuildingElevations?: Pick<SharedValueMap<string, number>, "get">;
  /** Other footprints in the current map batch, used to detect party walls. */
  neighboringBuildingFootprints?: readonly BuildingPolygon[];
}

export interface BuildingAppearance {
  wall: Color3;
  roof: Color3;
  trim: Color3;
  wallSurface: BuildingSurface;
  roofSurface: BuildingSurface;
}

export interface PreparedBuildingFootprint {
  outline: ScenePoint[];
  holes: ScenePoint[][];
  baseElevation: number;
}

export interface ScenePoint {
  x: number;
  z: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface DetailedBuildingParts {
  facadeInteriorParts: (parts: Mesh[], bottom?: number, top?: number) => Generator<string, void, void>;
  createShellDoors: (parent: TransformNode, bottom?: number, top?: number) => void;
  /** Reuses exterior planning; creates no interior geometry until advanced. */
  interiorParts: (parts: Mesh[]) => Generator<string, void, void>;
  floors: {
    bottom: number;
    top: number;
    structure: (parts: Mesh[]) => Generator<string, void, void>;
    furniture: (parts: Mesh[]) => Generator<string, void, void>;
  }[];
  parts: Mesh[];
  windowCount: number;
  floorCount: number;
  stairFlightCount: number;
  entranceEdgeIndex: number;
  stairEdgeIndex?: number;
  stairEdgeIndices: number[];
  stairFlightCenters: ScenePoint[];
  windowStyleId: string;
  windowRegion: string;
  plannedInterior: boolean;
  roofAccess?: RoofAccess;
}

export interface PlannedInterior {
  building: BuildingLayout;
  apartments: ApartmentLayout[];
}

export interface InteriorPlanningAttempt {
  input: Parameters<typeof import("../buildings/BuildingLayoutPlanner").planBuildingLayout>[0];
  interior?: PlannedInterior;
  failure?: string;
}

export interface PendingBuildingInterior {
  id: string;
  center: Vector3;
  radiusMeters: number;
  distanceTo: (position: Vector3) => number;
  createGate: (parent: TransformNode) => Mesh;
  build: (root: TransformNode) => Generator<string, void, void>;
  floors?: PendingBuildingInterior[];
  /** Floor elevations and prefetch margin in building-local scene units. */
  floor?: { bottom: number; top: number; margin: number; metersPerUnit: number; index: number };
  furnish?: (root: TransformNode) => Generator<string, void, void>;
}

export interface LoadedBuildingInterior {
  center: Vector3;
  pending: PendingBuildingInterior;
  mesh: Mesh;
}

export interface StairLayout {
  edgeIndex: number;
  start: ScenePoint;
  direction: ScenePoint;
  inward: ScenePoint;
  runMeters: number;
  widthMeters: number;
}

export interface EntranceClearance {
  edgeIndex: number;
  centerMeters: number;
  widthMeters: number;
}

export interface WindowGeometry {
  positions: number[];
  indices: number[];
  normals: number[];
  colors: number[];
}

export interface BuildingShadowRange {
  indexStart: number;
  indexCount: number;
}

export type { BuildingPlan, ApartmentLayout, BuildingLayout, Opening2D, Point2D };
