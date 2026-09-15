import { Color3, Mesh, MeshBuilder, Scene, VertexBuffer } from "@babylonjs/core";
import type { BuildingPlan } from "../buildings/BuildingPlanner";
import { distanceToRing, pointBounds, pointInRing, signedArea, type PlanarPoint } from "../core/PlanarGeometry";
import { createSeededRandom } from "../core/Random";
import { setBuildingSurface, type BuildingSurface } from "./BuildingMaterial";

export interface RooftopPlacement extends PlanarPoint {
  kind: "access" | "ac" | "vent";
  width: number;
  depth: number;
  height: number;
  angle: number;
}

/** All dimensions and coordinates are in meters, independent of tile scale. */
export function planRooftopEquipment(
  plan: BuildingPlan,
  outline: readonly PlanarPoint[],
  holes: readonly PlanarPoint[][] = [],
): RooftopPlacement[] {
  const area = Math.abs(signedArea(outline)) - holes.reduce((sum, hole) => sum + Math.abs(signedArea(hole)), 0);
  const floors = Math.min(plan.levels ?? Infinity, (plan.heightMeters - plan.minimumHeightMeters) / 3.1);
  const random = createSeededRandom(plan.detailSeed ^ 0x5e47ac19);
  if (area < 28 || plan.heightMeters < 2.8 || random() > Math.min(1, 0.25 + floors * 0.18)) return [];
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
  const placements: RooftopPlacement[] = [];
  for (let index = 0; index < count; index++) {
    const kind = index === 0 && floors >= 3 ? "access" : index % 3 === 2 ? "vent" : "ac";
    const width = kind === "access" ? 2.6 : kind === "ac" ? 1.4 + random() * 1.2 : 0.7;
    const depth = kind === "access" ? 3.4 : kind === "ac" ? 1 + random() * 0.5 : 0.7;
    const height = kind === "access" ? 2.5 : kind === "ac" ? 0.85 + random() * 0.5 : 1.2;
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
): Mesh | undefined {
  const toMeters = (point: PlanarPoint): PlanarPoint => ({ x: point.x * metersPerUnit, z: point.z * metersPerUnit });
  const placements = planRooftopEquipment(plan, outline.map(toMeters), holes.map((hole) => hole.map(toMeters)));
  const parts: Mesh[] = [];
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
    box(item.width, 0.16, item.depth, 0.08, dark);
    box(item.width, item.height, item.depth, 0.16 + item.height / 2,
      item.kind === "access" ? wallColor : metal, 0, 0, item.kind === "access" ? "concrete" : "metal");
    if (item.kind === "access") {
      box(item.width + 0.2, 0.14, item.depth + 0.2, item.height + 0.23, metal);
      box(0.9, 2.05, 0.035, 1.185, dark, 0, -item.depth / 2 - 0.02);
      box(0.06, 0.16, 0.06, 1.2, metal, 0.3, -item.depth / 2 - 0.05);
    } else if (item.kind === "ac") {
      const fans = item.width > 1.9 ? 2 : 1;
      for (let fan = 0; fan < fans; fan++) {
        finish(MeshBuilder.CreateCylinder("rooftopFan", {
          diameter: 0.72 / metersPerUnit, height: 0.05 / metersPerUnit, tessellation: 12,
        }, scene), (fan - (fans - 1) / 2) * 0.95, item.height + 0.19, 0, dark, "metal");
      }
      for (let grille = 0; grille < 4; grille++) {
        box(item.width * 0.82, 0.045, 0.035, 0.35 + grille * 0.14, dark, 0, -item.depth / 2 - 0.02);
      }
    } else {
      box(item.width + 0.25, 0.16, item.depth + 0.25, item.height + 0.3, dark);
    }
  }
  if (!parts.length) return undefined;
  const mesh = Mesh.MergeMeshes(parts, true, true) ?? undefined;
  if (mesh) mesh.setEnabled(false);
  return mesh;
}
