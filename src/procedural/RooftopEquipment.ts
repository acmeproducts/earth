import { Color3, Mesh, MeshBuilder, Scene, VertexBuffer } from "@babylonjs/core";
import type { BuildingPlan } from "../buildings/BuildingPlanner";
import { distanceToRing, pointBounds, pointInRing, signedArea, type PlanarPoint } from "../core/PlanarGeometry";
import { createSeededRandom } from "../core/Random";
import { setBuildingSurface, type BuildingSurface } from "./BuildingMaterial";
import { createBuildingDoor } from "./BuildingDoor";
import type { StairLayout } from "./BuildingRendererTypes";
import { BUILDING_STAIR_LANDING_METERS } from "./BuildingRendererConstants";
import polygonClipping from "polygon-clipping";

export interface RooftopPlacement extends PlanarPoint {
  kind: "access" | "ac" | "vent";
  width: number;
  depth: number;
  height: number;
  angle: number;
}

export interface RoofAccess {
  stair: StairLayout;
  placement: RooftopPlacement;
}

export function planRoofAccess(
  stair: StairLayout, outline: readonly PlanarPoint[], holes: readonly PlanarPoint[][], metersPerUnit: number,
): RoofAccess | undefined {
  const depth = stair.runMeters + BUILDING_STAIR_LANDING_METERS + 0.3;
  const along = depth / 2 - 0.3;
  const placement: RooftopPlacement = {
    kind: "access", x: stair.start.x * metersPerUnit + stair.direction.x * along,
    z: stair.start.z * metersPerUnit + stair.direction.z * along,
    width: stair.widthMeters + 0.52, depth, height: 2.5,
    angle: Math.atan2(-stair.direction.x, -stair.direction.z),
  };
  // Include space outside the door as well as the enclosure and its roof lip.
  const clearance: polygonClipping.Ring = [
    [-placement.width / 2 - 0.1, -depth / 2 - 1], [placement.width / 2 + 0.1, -depth / 2 - 1],
    [placement.width / 2 + 0.1, depth / 2 + 0.1], [-placement.width / 2 - 0.1, depth / 2 + 0.1],
  ].map(([x, z]) => [
    (placement.x + x * Math.cos(placement.angle) + z * Math.sin(placement.angle)) / metersPerUnit,
    (placement.z - x * Math.sin(placement.angle) + z * Math.cos(placement.angle)) / metersPerUnit,
  ]);
  const footprint = [outline, ...holes].map((ring) => ring.map((p): [number, number] => [p.x, p.z]));
  return polygonClipping.difference([clearance], footprint).length ? undefined : { stair, placement };
}

/** All dimensions and coordinates are in meters, independent of tile scale. */
export function planRooftopEquipment(
  plan: BuildingPlan,
  outline: readonly PlanarPoint[],
  holes: readonly PlanarPoint[][] = [],
  access?: RooftopPlacement,
): RooftopPlacement[] {
  const area = Math.abs(signedArea(outline)) - holes.reduce((sum, hole) => sum + Math.abs(signedArea(hole)), 0);
  const floors = Math.min(plan.levels ?? Infinity, (plan.heightMeters - plan.minimumHeightMeters) / 3.1);
  const random = createSeededRandom(plan.detailSeed ^ 0x5e47ac19);
  if (area < 28 || plan.heightMeters < 2.8 || random() > Math.min(1, 0.25 + floors * 0.18)) return access ? [access] : [];
  const bounds = pointBounds(outline);
  let edge = 0;
  for (let i = 1; i < outline.length; i++) {
    const length = (index: number): number => Math.hypot(
      outline[(index + 1) % outline.length].x - outline[index].x,
      outline[(index + 1) % outline.length].z - outline[index].z,
    );
    if (length(i) > length(edge)) edge = i;
  }
  const next = outline[(edge + 1) % outline.length];
  const angle = -Math.atan2(next.z - outline[edge].z, next.x - outline[edge].x);
  const count = Math.min(10, Math.max(1, Math.floor(area / 160) + Math.floor(floors / 3)));
  const placements: RooftopPlacement[] = access ? [access] : [];
  for (let index = 0; index < count; index++) {
    const kind = index % 3 === 2 ? "vent" : "ac";
    const width = kind === "ac" ? 1.4 + random() * 1.2 : 0.7;
    const depth = kind === "ac" ? 1 + random() * 0.5 : 0.7;
    const height = kind === "ac" ? 0.85 + random() * 0.5 : 1.2;
    // A circumscribed disk covers every corner, cap and fitting. This also
    // rejects placements spanning concave notches or small courtyard holes.
    const radius = Math.hypot(width, depth) / 2 + 0.3;
    for (let attempt = 0; attempt < 48; attempt++) {
      const center = {
        x: bounds.minX + random() * (bounds.maxX - bounds.minX),
        z: bounds.minZ + random() * (bounds.maxZ - bounds.minZ),
      };
      if (!pointInRing(center, outline) || distanceToRing(center, outline) < radius + 0.65) continue;
      if (holes.some((hole) => pointInRing(center, hole) || distanceToRing(center, hole) < radius + 0.65)) continue;
      if (placements.some((other) => Math.hypot(center.x - other.x, center.z - other.z) <
        radius + Math.hypot(other.width, other.depth) / 2 + 0.8)) continue;
      placements.push({ ...center, kind, width, depth, height, angle });
      break;
    }
  }
  return placements;
}

export function createRooftopEquipment(
  scene: Scene,
  plan: BuildingPlan,
  outline: readonly PlanarPoint[],
  holes: readonly PlanarPoint[][],
  roofElevation: number,
  metersPerUnit: number,
  wallColor: Color3,
  access?: RooftopPlacement,
): Mesh | undefined {
  const toMeters = (point: PlanarPoint): PlanarPoint => ({ x: point.x * metersPerUnit, z: point.z * metersPerUnit });
  const placements = planRooftopEquipment(plan, outline.map(toMeters), holes.map((hole) => hole.map(toMeters)), access);
  const parts: Mesh[] = [];
  const doors: Mesh[] = [];
  const metal = new Color3(0.57, 0.61, 0.61);
  const dark = new Color3(0.14, 0.17, 0.18);
  for (const item of placements) {
    const finish = (mesh: Mesh, x: number, y: number, z: number, color: Color3, surface: BuildingSurface): void => {
      mesh.position.set(
        (item.x + x * Math.cos(item.angle) + z * Math.sin(item.angle)) / metersPerUnit,
        (roofElevation + y) / metersPerUnit,
        (item.z - x * Math.sin(item.angle) + z * Math.cos(item.angle)) / metersPerUnit,
      );
      mesh.rotation.y = item.angle;
      mesh.setVerticesData(VertexBuffer.ColorKind, Array.from({ length: mesh.getTotalVertices() }, () => [color.r, color.g, color.b, 1]).flat());
      setBuildingSurface(mesh, surface);
      mesh.setEnabled(false);
      parts.push(mesh);
    };
    const box = (width: number, height: number, depth: number, y: number, color: Color3,
      x = 0, z = 0, surface: BuildingSurface = "metal"): void => {
      finish(MeshBuilder.CreateBox("rooftopEquipment", {
        width: width / metersPerUnit, height: height / metersPerUnit, depth: depth / metersPerUnit,
      }, scene), x, y, z, color, surface);
    };
    if (item.kind !== "access") box(item.width, 0.16, item.depth, 0.08, dark);
    if (item.kind === "access") {
      const thickness = 0.16;
      const doorWidth = 0.9, doorHeight = 2.05;
      const sideWidth = (item.width - doorWidth) / 2;
      for (const side of [-1, 1]) {
        box(thickness, item.height, item.depth, item.height / 2,
          wallColor, side * (item.width - thickness) / 2, 0, "concrete");
        box(sideWidth, item.height, thickness, item.height / 2,
          wallColor, side * (doorWidth + sideWidth) / 2, -(item.depth - thickness) / 2, "concrete");
      }
      box(item.width, item.height, thickness, item.height / 2,
        wallColor, 0, (item.depth - thickness) / 2, "concrete");
      box(doorWidth, item.height - doorHeight, thickness, (item.height + doorHeight) / 2,
        wallColor, 0, -(item.depth - thickness) / 2, "concrete");
      box(item.width + 0.2, 0.14, item.depth + 0.2, item.height + 0.07, metal);
      const endpoint = (x: number) => ({
        x: item.x + x * Math.cos(item.angle) - (item.depth - thickness) / 2 * Math.sin(item.angle),
        y: item.z - x * Math.sin(item.angle) - (item.depth - thickness) / 2 * Math.cos(item.angle),
      });
      doors.push(createBuildingDoor(scene, {
        id: `${plan.id}:roof-access`, type: "door", start: endpoint(-doorWidth / 2), end: endpoint(doorWidth / 2),
      }, roofElevation, doorHeight, metersPerUnit));
    } else {
      box(item.width, item.height, item.depth, 0.16 + item.height / 2, metal);
    }
    if (item.kind === "ac") {
      const fans = item.width > 1.9 ? 2 : 1;
      for (let fan = 0; fan < fans; fan++) {
        finish(MeshBuilder.CreateCylinder("rooftopFan", {
          diameter: 0.72 / metersPerUnit, height: 0.05 / metersPerUnit, tessellation: 12,
        }, scene), (fan - (fans - 1) / 2) * 0.95, item.height + 0.19, 0, dark, "metal");
      }
      for (let grille = 0; grille < 4; grille++) {
        box(item.width * 0.82, 0.045, 0.035, 0.35 + grille * 0.14, dark, 0, -item.depth / 2 - 0.02);
      }
    } else if (item.kind === "vent") {
      box(item.width + 0.25, 0.16, item.depth + 0.25, item.height + 0.24, dark);
    }
  }
  if (!parts.length) return undefined;
  const mesh = Mesh.MergeMeshes(parts, true, true) ?? undefined;
  if (mesh) {
    for (const door of doors) door.setParent(mesh);
    mesh.setEnabled(false);
  }
  return mesh;
}
