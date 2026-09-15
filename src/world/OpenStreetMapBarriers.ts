import {
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import {
  clipPolyline,
  HorizontalExclusionMask,
  lonLatToScene,
  pointSegmentDistanceSquared,
  resamplePath,
  sampleElevation,
} from "./Geo";
import { acquireBushImpostorAssets, createBushModel } from "../vegetation/BushImpostor";
import { createVegetationFieldRenderers } from "../vegetation/VegetationFieldRenderers";
import { createVegetationFieldResult } from "../vegetation/VegetationField";
import type { VegetationFieldResult } from "../vegetation/VegetationField";
import type { TerrainData } from "../terrain/TerrainData";
import type { PlannedPlotBoundary } from "../roads/RoadAndBuildingPlanner";
import { setVegetationWindShear } from "../procedural/ProceduralCaptureMaterial";
import { windShearFraction } from "../vegetation/Wind";

export type BarrierType =
  | "hedge"
  | "fence"
  | "wall"
  | "guard_rail"
  | "jersey_barrier"
  | "cable_barrier"
  | "retaining_wall";

export interface BarrierFeature {
  id: number;
  type: BarrierType;
  coordinates: Array<readonly [number, number]>;
  tags: Readonly<Record<string, string>>;
}
export interface BarrierLayerOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  startDisabled?: boolean;
}

export interface BarrierFeatureLayer {
  root: TransformNode;
  meshes: Mesh[];
  count: number;
  hedgeField?: VegetationFieldResult;
}

interface BarrierAppearance {
  style: "hedge" | "woodFence" | "chainlink" | "guardRail" | "wall" | "noiseBarrier" | "jerseyBarrier";
  heightMeters: number;
}

interface HorizontalSegment {
  start: { x: number; z: number };
  end: { x: number; z: number };
  halfWidth: number;
}

/** Renders linear barrier features supplied by a map-data source. */
export class OpenStreetMapBarriers {
  static async createLayer(
    scene: Scene,
    features: readonly BarrierFeature[],
    terrain: TerrainData,
    options: BarrierLayerOptions,
    yieldControl?: () => Promise<void>,
  ): Promise<BarrierFeatureLayer> {
    return createBarrierLayer(scene, features.map((feature) => ({
      appearance: barrierAppearance(feature),
      paths: clipPolyline(
        feature.coordinates.map(([lon, lat]) =>
          lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
        ),
        options.meshWidth / 2,
        options.meshDepth / 2,
      ),
    })), terrain, options, yieldControl);
  }

  static async createPlannedLayer(
    scene: Scene,
    boundaries: readonly PlannedPlotBoundary[],
    terrain: TerrainData,
    options: BarrierLayerOptions,
    yieldControl?: () => Promise<void>,
  ): Promise<BarrierFeatureLayer> {
    return createBarrierLayer(scene, boundaries.map((boundary) => ({
      appearance: {
        style: boundary.style,
        heightMeters: boundary.style === "hedge" ? 1.45 : 1.15,
      },
      paths: [[...boundary.path]],
    })), terrain, options, yieldControl);
  }

  static createPlannedExclusionMask(
    boundaries: readonly PlannedPlotBoundary[],
    options: Pick<BarrierLayerOptions, "metersPerUnit">,
  ): HorizontalExclusionMask {
    return segmentExclusionMask(boundaries.map((boundary) => ({
      start: boundary.path[0],
      end: boundary.path[1],
      halfWidth: (boundary.style === "hedge" ? 0.9 : 0.35) / options.metersPerUnit,
    })), options.metersPerUnit);
  }

  /** Prevents procedurally placed trees and shrubs from crossing solid mapped barriers. */
  static createExclusionMask(
    features: readonly BarrierFeature[],
    terrain: TerrainData,
    options: Pick<BarrierLayerOptions, "meshWidth" | "meshDepth" | "metersPerUnit">,
  ): HorizontalExclusionMask {
    const segments: HorizontalSegment[] = [];
    for (const feature of features) {
      const projected = feature.coordinates.map(([lon, lat]) =>
        lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth),
      );
      const clearanceMeters = feature.type === "hedge" ? 0.9 : 0.35;
      for (const path of clipPolyline(projected, options.meshWidth / 2, options.meshDepth / 2)) {
        for (let index = 1; index < path.length; index++) {
          segments.push({
            start: path[index - 1],
            end: path[index],
            halfWidth: clearanceMeters / options.metersPerUnit,
          });
        }
      }
    }
    return segmentExclusionMask(segments, options.metersPerUnit);
  }

}

interface RenderableBarrier {
  appearance: BarrierAppearance;
  paths: Array<Array<{ x: number; z: number }>>;
}

async function createBarrierLayer(
  scene: Scene,
  features: readonly RenderableBarrier[],
  terrain: TerrainData,
  options: BarrierLayerOptions,
  yieldControl?: () => Promise<void>,
): Promise<BarrierFeatureLayer> {
    const root = new TransformNode("barriers", scene);
    if (options.startDisabled) root.setEnabled(false);
    const byStyle = new Map<BarrierAppearance["style"], Mesh[]>();
    const hedgeMatrices: Matrix[] = [];
    let count = 0;

    for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
      const feature = features[featureIndex];
      const appearance = feature.appearance;
      let rendered = false;
      for (const path of feature.paths) {
        const sampled = resamplePath(path, 2 / options.metersPerUnit);
        const mesh = appearance.style === "hedge"
          ? undefined
          : appearance.style === "woodFence"
            ? createFence(scene, sampled, terrain, options, appearance.heightMeters)
            : appearance.style === "chainlink"
              ? createChainlinkFence(scene, sampled, terrain, options, appearance.heightMeters)
            : createBarrierRibbon(scene, sampled, terrain, options, appearance.heightMeters, appearance.style);
        if (appearance.style === "hedge") {
          hedgeMatrices.push(...createHedgeMatrices(sampled, terrain, options, appearance.heightMeters));
          rendered = sampled.length >= 2;
          continue;
        }
        if (!mesh) continue;
        const meshes = byStyle.get(appearance.style);
        if (meshes) meshes.push(mesh);
        else byStyle.set(appearance.style, [mesh]);
        rendered = true;
      }
      if (rendered) count++;
      if ((featureIndex + 1) % 24 === 0) await yieldControl?.();
    }

    const meshes: Mesh[] = [];
    let hedgeField: VegetationFieldResult | undefined;
    if (hedgeMatrices.length > 0) {
      const hedgeRoot = new TransformNode("hedgerowBushes", scene);
      hedgeRoot.parent = root;
      const renderers = await createVegetationFieldRenderers(scene, {
        rootName: "hedgerowBushRenderers",
        impostorName: "hedgerowBushImpostors",
        renderHeight: 1.6 / options.metersPerUnit,
        loadAssets: () => acquireBushImpostorAssets(scene, { key: "default" }),
        createModel: () => createBushModel(scene, 1.6 / options.metersPerUnit),
      });
      renderers.root.parent = hedgeRoot;
      setVegetationWindShear(
        [renderers.impostor, renderers.model],
        windShearFraction("bush"),
      );
      hedgeField = await createVegetationFieldResult(
        renderers.root,
        [renderers.impostor],
        [renderers.model],
        packMatrices(hedgeMatrices),
        options.metersPerUnit,
        "auto",
        undefined,
        yieldControl,
      );
      /*
       * The normal vegetation field owns both representations and performs
       * the model/impostor transition. The barrier root still owns the field
       * through this child, so disposal remains tied to the mapped feature.
       */
      meshes.push(...hedgeField.meshes);
    }
    /* Keep the field available to Game so hedges receive normal LOD updates. */
    const hedgeFieldResult = hedgeField;
    for (const [style, sources] of byStyle) {
      const merged = sources.length === 1 ? sources[0] : Mesh.MergeMeshes(sources, true, true);
      if (!merged) continue;
      merged.name = `${style}Barriers`;
      merged.material = createBarrierMaterial(scene, style);
      merged.isPickable = false;
      merged.parent = root;
      merged.setEnabled(true);
      meshes.push(merged);
    }
    return { root, meshes, count, hedgeField: hedgeFieldResult };
}

function segmentExclusionMask(
  segments: HorizontalSegment[],
  metersPerUnit: number,
): HorizontalExclusionMask {
  return new SegmentExclusionMask(segments, 12 / metersPerUnit);
}

function barrierAppearance(feature: BarrierFeature): BarrierAppearance {
  const taggedHeight = positiveMeters(feature.tags.height);
  switch (feature.type) {
    case "hedge": return { style: "hedge", heightMeters: taggedHeight ?? 1.6 };
    case "fence": return {
      style: isWoodFence(feature) ? "woodFence" : "chainlink",
      heightMeters: taggedHeight ?? 1.5,
    };
    case "guard_rail": return { style: "guardRail", heightMeters: taggedHeight ?? 0.78 };
    case "cable_barrier": return { style: "chainlink", heightMeters: taggedHeight ?? 0.85 };
    case "jersey_barrier": return { style: "jerseyBarrier", heightMeters: taggedHeight ?? 0.82 };
    case "retaining_wall": return { style: "wall", heightMeters: taggedHeight ?? 1.5 };
    case "wall": return {
      style: feature.tags.wall === "noise_barrier" ? "noiseBarrier" : "wall",
      heightMeters: taggedHeight ?? (feature.tags.wall === "noise_barrier" ? 3 : 1.8),
    };
  }
}

/** OSM material tagging is sparse, so an ordinary fence defaults to metal mesh. */
function isWoodFence(feature: BarrierFeature): boolean {
  const material = (feature.tags.material ?? "").toLowerCase();
  const fenceType = (feature.tags.fence_type ?? "").toLowerCase();
  return material.includes("wood") || fenceType.includes("wood") || fenceType.includes("paling") ||
    fenceType.includes("board") || fenceType.includes("privacy");
}

function positiveMeters(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 12) : undefined;
}

function createHedgeMatrices(
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: BarrierLayerOptions,
  heightMeters: number,
): Matrix[] {
  if (points.length < 2) return [];
  const matrices: Matrix[] = [];
  const spacing = 0.86 / options.metersPerUnit;
  const across = [-0.32, 0, 0.32].map((offset) => offset / options.metersPerUnit);
  const burialDepth = 0.12 / options.metersPerUnit;
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(length / spacing));
    const normalX = length > 0 ? -dz / length : 0;
    const normalZ = length > 0 ? dx / length : 0;
    const yaw = Math.atan2(dx, dz);
    for (let step = 0; step < steps; step++) {
      const amount = (step + 0.5) / steps;
      const centerX = start.x + dx * amount;
      const centerZ = start.z + dz * amount;
      const ground = sampleElevation(terrain, centerX, centerZ, options.meshWidth, options.meshDepth) /
        options.metersPerUnit;
      across.forEach((offset, acrossIndex) => {
        const scale = 0.58 + ((index * 17 + step * 7 + Math.round(offset * 100)) % 5) * 0.028;
        // Keep each bush's orientation stable while avoiding a visible repeating
        // three-angle pattern along the hedge line.
        const instanceSeed = index * 92821 + step * 68917 + acrossIndex * 283;
        const rotationJitter = Math.sin(instanceSeed) * 0.18;
        matrices.push(Matrix.Compose(
          new Vector3(
            scale,
            (heightMeters / 1.6) * (0.86 + scale * 0.38),
            scale,
          ),
          new Vector3(0, yaw + rotationJitter, 0).toQuaternion(),
          new Vector3(centerX + normalX * offset, ground - burialDepth, centerZ + normalZ * offset),
        ));
      });
    }
  }
  return matrices;
}

function packMatrices(matrices: readonly Matrix[]): Float32Array {
  const packed = new Float32Array(matrices.length * 16);
  matrices.forEach((matrix, index) => matrix.copyToArray(packed, index * 16));
  return packed;
}

function createFence(
  scene: Scene,
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: BarrierLayerOptions,
  heightMeters: number,
): Mesh | undefined {
  if (points.length < 2) return undefined;
  const parts: Mesh[] = [];
  const postSpacing = 2 / options.metersPerUnit;
  const railHeights = [0.42, 0.92].map((height) => height * heightMeters / 1.5 / options.metersPerUnit);
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    if (length === 0) continue;
      const yaw = Math.atan2(dx, dz);
    const steps = Math.max(1, Math.ceil(length / postSpacing));
    for (let step = 0; step <= steps; step++) {
      const amount = Math.min(1, step / steps);
      const x = start.x + dx * amount;
      const z = start.z + dz * amount;
      const ground = sampleElevation(terrain, x, z, options.meshWidth, options.meshDepth) / options.metersPerUnit;
      const post = MeshBuilder.CreateCylinder("fencePost", {
        height: heightMeters / options.metersPerUnit,
        diameter: 0.11 / options.metersPerUnit,
        tessellation: 6,
      }, scene);
      post.position.set(x, ground + heightMeters / options.metersPerUnit / 2, z);
      parts.push(post);
    }
    for (const railHeight of railHeights) {
      const amount = 0.5;
      const x = start.x + dx * amount;
      const z = start.z + dz * amount;
      const ground = sampleElevation(terrain, x, z, options.meshWidth, options.meshDepth) / options.metersPerUnit;
      const rail = MeshBuilder.CreateCylinder("fenceRail", {
        height: length + 0.04 / options.metersPerUnit,
        diameter: 0.09 / options.metersPerUnit,
        tessellation: 6,
      }, scene);
      // Cylinders are authored along local Y. Rotate that axis directly onto
      // the horizontal segment direction; Euler rotations here twist rails
      // onto the wrong diagonal for most fence headings.
      rail.rotationQuaternion = Quaternion.RotationAxis(
        new Vector3(Math.cos(yaw), 0, -Math.sin(yaw)),
        Math.PI / 2,
      );
      rail.position.set(x, ground + railHeight, z);
      parts.push(rail);
    }
  }
  const mesh = Mesh.MergeMeshes(parts, true, true);
  if (!mesh) return undefined;
  mesh.setEnabled(false);
  return mesh;
}

function createChainlinkFence(
  scene: Scene,
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: BarrierLayerOptions,
  heightMeters: number,
): Mesh | undefined {
  if (points.length < 2) return undefined;
  const parts: Mesh[] = [];
  const postSpacing = 2 / options.metersPerUnit;
  const meshSpacing = 0.22 / options.metersPerUnit;
  const wireDiameter = 0.018 / options.metersPerUnit;

  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dz);
    if (length === 0) continue;
    const steps = Math.max(1, Math.ceil(length / postSpacing));
    for (let step = 0; step <= steps; step++) {
      const amount = Math.min(1, step / steps);
      const x = start.x + dx * amount;
      const z = start.z + dz * amount;
      const ground = sampleElevation(terrain, x, z, options.meshWidth, options.meshDepth) /
        options.metersPerUnit;
      const post = MeshBuilder.CreateCylinder("chainlinkPost", {
        height: heightMeters / options.metersPerUnit,
        diameter: 0.055 / options.metersPerUnit,
        tessellation: 6,
      }, scene);
      post.position.set(x, ground + heightMeters / options.metersPerUnit / 2, z);
      parts.push(post);
    }

    const panelSteps = Math.max(1, Math.ceil(length / meshSpacing));
    const panelStep = length / panelSteps;
    const panelHeight = heightMeters / options.metersPerUnit;
    for (let step = 0; step < panelSteps; step++) {
      const distance = step * panelStep;
      const nextDistance = (step + 1) * panelStep;
      const base = pointAlong(start, end, distance / length);
      const next = pointAlong(start, end, nextDistance / length);
      const baseGround = sampleElevation(terrain, base.x, base.z, options.meshWidth, options.meshDepth) /
        options.metersPerUnit;
      const nextGround = sampleElevation(terrain, next.x, next.z, options.meshWidth, options.meshDepth) /
        options.metersPerUnit;
      for (let row = 0; row < Math.ceil(panelHeight / meshSpacing); row++) {
        const low = row * meshSpacing;
        const high = Math.min(panelHeight, low + meshSpacing);
        if (high <= low) continue;
        parts.push(createWire(scene, base.x, baseGround + low, base.z, next.x, nextGround + high, next.z, wireDiameter));
        parts.push(createWire(scene, base.x, baseGround + high, base.z, next.x, nextGround + low, next.z, wireDiameter));
      }
    }
  }
  const mesh = Mesh.MergeMeshes(parts, true, true);
  if (!mesh) return undefined;
  mesh.setEnabled(false);
  return mesh;
}

function pointAlong(start: { x: number; z: number }, end: { x: number; z: number }, amount: number) {
  return { x: start.x + (end.x - start.x) * amount, z: start.z + (end.z - start.z) * amount };
}

function createWire(
  scene: Scene,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  diameter: number,
): Mesh {
  const start = new Vector3(startX, startY, startZ);
  const end = new Vector3(endX, endY, endZ);
  const direction = end.subtract(start);
  const wire = MeshBuilder.CreateCylinder("chainlinkWire", {
    height: direction.length(),
    diameter,
    tessellation: 5,
  }, scene);
  wire.position = start.add(end).scale(0.5);
  wire.rotationQuaternion = Quaternion.FromUnitVectorsToRef(Vector3.Up(), direction.normalize(), new Quaternion());
  return wire;
}

function createBarrierRibbon(
  scene: Scene,
  points: Array<{ x: number; z: number }>,
  terrain: TerrainData,
  options: BarrierLayerOptions,
  heightMeters: number,
  style: BarrierAppearance["style"],
): Mesh | undefined {
  if (points.length < 2) return undefined;
  const groundClearance = style === "guardRail" ? 0.42 : 0.025;
  const visibleHeight = style === "guardRail" ? 0.34 : heightMeters;
  const bottom: Vector3[] = [];
  const top: Vector3[] = [];
  for (const point of points) {
    const ground = sampleElevation(
      terrain,
      point.x,
      point.z,
      options.meshWidth,
      options.meshDepth,
    );
    bottom.push(new Vector3(
      point.x,
      (ground + groundClearance) / options.metersPerUnit,
      point.z,
    ));
    top.push(new Vector3(
      point.x,
      (ground + groundClearance + visibleHeight) / options.metersPerUnit,
      point.z,
    ));
  }
  const mesh = MeshBuilder.CreateRibbon("barrier", { pathArray: [bottom, top] }, scene);
  mesh.setEnabled(false);
  return mesh;
}

function createBarrierMaterial(scene: Scene, style: BarrierAppearance["style"]): StandardMaterial {
  const material = new StandardMaterial(`${style}BarrierMaterial`, scene);
  material.backFaceCulling = false;
  material.specularColor = new Color3(0.03, 0.03, 0.03);
  switch (style) {
    case "hedge":
      material.diffuseColor = new Color3(0.12, 0.27, 0.075);
      break;
    case "woodFence":
      material.diffuseColor = new Color3(0.28, 0.18, 0.1);
      break;
    case "chainlink":
      material.diffuseColor = new Color3(0.36, 0.38, 0.37);
      material.specularColor = new Color3(0.2, 0.21, 0.2);
      break;
    case "guardRail":
      material.diffuseColor = new Color3(0.48, 0.5, 0.49);
      material.specularColor = new Color3(0.28, 0.29, 0.28);
      break;
    case "noiseBarrier":
      material.diffuseColor = new Color3(0.38, 0.42, 0.35);
      break;
    case "jerseyBarrier":
      material.diffuseColor = new Color3(0.49, 0.48, 0.45);
      break;
    case "wall":
      material.diffuseColor = new Color3(0.37, 0.35, 0.31);
      break;
  }
  return material;
}

class SegmentExclusionMask implements HorizontalExclusionMask {
  private readonly cells = new Map<string, HorizontalSegment[]>();

  constructor(segments: readonly HorizontalSegment[], private readonly cellSize: number) {
    for (const segment of segments) {
      const minimumX = Math.floor((Math.min(segment.start.x, segment.end.x) - segment.halfWidth) / cellSize);
      const maximumX = Math.floor((Math.max(segment.start.x, segment.end.x) + segment.halfWidth) / cellSize);
      const minimumZ = Math.floor((Math.min(segment.start.z, segment.end.z) - segment.halfWidth) / cellSize);
      const maximumZ = Math.floor((Math.max(segment.start.z, segment.end.z) + segment.halfWidth) / cellSize);
      for (let z = minimumZ; z <= maximumZ; z++) {
        for (let x = minimumX; x <= maximumX; x++) {
          const key = `${x},${z}`;
          const cell = this.cells.get(key);
          if (cell) cell.push(segment);
          else this.cells.set(key, [segment]);
        }
      }
    }
  }

  intersects(x: number, z: number, radius: number): boolean {
    const minimumX = Math.floor((x - radius) / this.cellSize);
    const maximumX = Math.floor((x + radius) / this.cellSize);
    const minimumZ = Math.floor((z - radius) / this.cellSize);
    const maximumZ = Math.floor((z + radius) / this.cellSize);
    for (let cellZ = minimumZ; cellZ <= maximumZ; cellZ++) {
      for (let cellX = minimumX; cellX <= maximumX; cellX++) {
        for (const segment of this.cells.get(`${cellX},${cellZ}`) ?? []) {
          const clearance = radius + segment.halfWidth;
          if (pointSegmentDistanceSquared(x, z, segment.start, segment.end) <= clearance * clearance) {
            return true;
          }
        }
      }
    }
    return false;
  }
}
