import {
  Color3,
  Mesh,
  MeshBuilder,
  PolygonMeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector2,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import earcut from "earcut";
import { lonLatToScene, sampleElevation, SEA_LEVEL_METERS } from "./Geo";
import { clamp01 } from "./MathUtils";
import type { BuildingPlan, LonLat } from "./BuildingPlanner";
import type { TerrainData } from "./TerrainData";

const BUILDING_GROUND_OVERLAP_METERS = 1;
const BUILDING_ROOF_TRIM_METERS = 0.32;
const BUILDING_ROOF_OVERHANG_METERS = 0.45;
const BUILDING_ROOF_EAVE_CLEARANCE_METERS = 0.2;
const BUILDING_WALL_THICKNESS_METERS = 0.24;
const BUILDING_FLOOR_THICKNESS_METERS = 0.16;
const BUILDING_DOOR_WIDTH_METERS = 1.15;
const BUILDING_DOOR_HEIGHT_METERS = 2.2;
const BUILDING_WINDOW_SILL_METERS = 0.82;
const BUILDING_WINDOW_HEIGHT_METERS = 1.35;
const BUILDING_WINDOW_SPACING_METERS = 3;

export interface BuildingRenderOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
}

interface BuildingAppearance {
  wall: Color3;
  roof: Color3;
  trim: Color3;
}

interface PreparedBuildingFootprint {
  outline: ScenePoint[];
  baseElevation: number;
}

interface ScenePoint {
  x: number;
  z: number;
}

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface DetailedBuildingParts {
  parts: Mesh[];
  windowCount: number;
  floorCount: number;
}

interface WindowGeometry {
  positions: number[];
  indices: number[];
  normals: number[];
  colors: number[];
}

/** Compiles semantic building plans into deterministic Babylon geometry. */
export class ProceduralBuildingRenderer {
  static createDetailed(
    scene: Scene,
    plan: BuildingPlan,
    terrain: TerrainData,
    options: BuildingRenderOptions,
  ): Mesh | undefined {
    const prepared = prepareBuildingFootprint(plan.footprint.outer, terrain, options);
    if (!prepared) return undefined;

    const appearance = buildingAppearance(plan);
    const areaSquareMeters = Math.abs(signedArea(prepared.outline)) * options.metersPerUnit ** 2;
    const roofShape = resolvedRoofShape(plan, prepared.outline, areaSquareMeters);
    const roofHeightMeters = roofShape === "flat"
      ? 0
      : plan.roofHeightMeters === undefined
        ? inferredRoofHeight(prepared.outline, areaSquareMeters, options, plan.detailSeed)
        : Math.min(
          plan.roofHeightMeters,
          Math.max(0, plan.heightMeters - Math.max(3, plan.minimumHeightMeters)),
        );
    // Provider heights rarely include usable roof metadata. Only subtract a
    // mapped roof height; inferred construction sits above the mapped massing.
    const wallTopElevation = prepared.baseElevation + plan.heightMeters -
      (plan.roofHeightMeters === undefined ? 0 : roofHeightMeters);
    const roofEaveElevation = wallTopElevation + BUILDING_ROOF_EAVE_CLEARANCE_METERS;
    const detailed = createEnterableBuilding(
      scene,
      plan,
      prepared.outline,
      prepared.baseElevation,
      wallTopElevation,
      options,
      appearance,
    );
    const parts = detailed.parts;
    const trim = createRoofTrim(
      scene,
      prepared.outline,
      wallTopElevation,
      options,
      appearance.trim,
      plan.detailSeed,
    );
    if (trim) parts.push(trim);

    if (roofHeightMeters > 0) {
      const roof = createPitchedRoof(
        scene,
        prepared.outline,
        roofEaveElevation,
        roofEaveElevation + roofHeightMeters,
        roofShape,
        options,
        appearance.roof,
        plan.detailSeed,
      );
      if (roof) parts.push(roof);
    } else {
      const rooftop = createRooftopVolume(
        scene,
        plan,
        prepared.outline,
        wallTopElevation,
        areaSquareMeters,
        options,
        appearance,
      );
      if (rooftop) parts.push(rooftop);
    }

    const merged = Mesh.MergeMeshes(parts, false, true);
    if (!merged) {
      for (const part of parts) part.dispose(false, true);
      return undefined;
    }
    for (const part of parts) part.dispose(false, true);
    merged.metadata = {
      buildingId: plan.id,
      enterable: true,
      windowCount: detailed.windowCount,
      interiorFloorCount: detailed.floorCount,
    };
    return stageBuildingMesh(merged);
  }

  /** Keeps the distant compiler to colored massing without roof detail. */
  static createFar(
    scene: Scene,
    plan: BuildingPlan,
    terrain: TerrainData,
    options: BuildingRenderOptions,
  ): Mesh | undefined {
    const prepared = prepareBuildingFootprint(plan.footprint.outer, terrain, options);
    if (!prepared) return undefined;
    const bottomElevation = plan.minimumHeightMeters > 0
      ? prepared.baseElevation + plan.minimumHeightMeters
      : terrain.minElevation - BUILDING_GROUND_OVERLAP_METERS;
    const mesh = createBuildingPrism(
      scene,
      prepared.outline,
      prepared.baseElevation + plan.heightMeters,
      bottomElevation,
      options,
    );
    colorBuildingMass(mesh, buildingAppearance(plan));
    return mesh;
  }

  static merge(meshes: Mesh[], name: string, parent: TransformNode): Mesh | undefined {
    if (meshes.length === 0) return undefined;
    const result = meshes.length === 1 ? meshes[0] : Mesh.MergeMeshes(meshes, true, true);
    if (!result) return undefined;
    const material = new StandardMaterial(`${name}Material`, result.getScene());
    material.diffuseColor = Color3.White();
    material.specularColor = new Color3(0.025, 0.025, 0.025);
    material.specularPower = 16;
    material.backFaceCulling = false;
    result.useVertexColors = true;
    result.name = name;
    result.material = material;
    result.parent = parent;
    result.checkCollisions = name === "buildings" || name === "detailedBuildings";
    return result;
  }
}

/**
 * Builds a hollow near-field shell. Facades are assembled around real window
 * and doorway apertures, while floor slabs make the volume read as an interior
 * from both the entrance and the windows.
 */
function createEnterableBuilding(
  scene: Scene,
  plan: BuildingPlan,
  outline: ScenePoint[],
  baseElevation: number,
  topElevation: number,
  options: BuildingRenderOptions,
  appearance: BuildingAppearance,
): DetailedBuildingParts {
  const usableHeight = Math.max(2.4, topElevation - baseElevation);
  const requestedFloors = plan.levels === undefined
    ? Math.max(1, Math.round(usableHeight / 3.1))
    : Math.max(1, Math.round(plan.levels));
  const floorCount = Math.min(20, requestedFloors);
  const storyHeight = usableHeight / floorCount;
  const entranceEdge = longestPolygonEdge(outline);
  const parts: Mesh[] = [];
  const windows: WindowGeometry = { positions: [], indices: [], normals: [], colors: [] };
  let windowCount = 0;

  const floorColor = mixColor(appearance.wall, new Color3(0.34, 0.31, 0.27), 0.48);
  for (let floor = 0; floor < floorCount; floor++) {
    const slabBottom = baseElevation + floor * storyHeight;
    const slab = createBuildingPrism(
      scene,
      outline,
      slabBottom + BUILDING_FLOOR_THICKNESS_METERS,
      slabBottom,
      options,
    );
    setSolidVertexColor(slab, floorColor);
    parts.push(slab);
  }

  for (let edgeIndex = 0; edgeIndex < outline.length; edgeIndex++) {
    const start = outline[edgeIndex];
    const end = outline[(edgeIndex + 1) % outline.length];
    const edgeLengthMeters = pointDistance(start, end) * options.metersPerUnit;
    if (edgeLengthMeters < 0.35) continue;
    const bayCount = Math.max(1, Math.min(16, Math.round(edgeLengthMeters / BUILDING_WINDOW_SPACING_METERS)));
    const bayWidth = edgeLengthMeters / bayCount;

    if (edgeIndex === entranceEdge) {
      const doorCenter = (Math.floor(bayCount / 2) + 0.5) * bayWidth;
      const doorWidth = Math.min(BUILDING_DOOR_WIDTH_METERS, bayWidth * 0.64);
      const doorHeight = Math.min(BUILDING_DOOR_HEIGHT_METERS, usableHeight - 0.28);
      addFacadePanel(parts, scene, start, end, edgeLengthMeters, 0,
        doorCenter - doorWidth / 2, baseElevation, usableHeight, options, appearance.wall);
      addFacadePanel(parts, scene, start, end, edgeLengthMeters,
        doorCenter + doorWidth / 2, edgeLengthMeters - doorCenter - doorWidth / 2,
        baseElevation, usableHeight, options, appearance.wall);
      addFacadePanel(parts, scene, start, end, edgeLengthMeters,
        doorCenter - doorWidth / 2, doorWidth, baseElevation + doorHeight,
        usableHeight - doorHeight, options, appearance.wall);
    } else {
      addFacadePanel(parts, scene, start, end, edgeLengthMeters, 0,
        edgeLengthMeters, baseElevation, usableHeight, options, appearance.wall);
    }

    for (let floor = 0; floor < floorCount; floor++) {
      const storyBottom = baseElevation + floor * storyHeight;
      for (let bay = 0; bay < bayCount; bay++) {
        const isEntrance = floor === 0 && edgeIndex === entranceEdge &&
          bay === Math.floor(bayCount / 2);
        if (isEntrance) continue;
        const apertureWidth = Math.min(1.65, Math.max(0.55, bayWidth * 0.56));
        const apertureHeight = Math.min(BUILDING_WINDOW_HEIGHT_METERS, storyHeight - 1.18);
        const sillHeight = Math.min(
          BUILDING_WINDOW_SILL_METERS,
          storyHeight - apertureHeight - 0.3,
        );
        const bayStart = bay * bayWidth;
        if (apertureHeight > 0.35) {
          const glass = varyColor(
            new Color3(0.24, 0.38, 0.45),
            seededUnit(plan.detailSeed ^ (edgeIndex * 131 + floor * 29 + bay)) * 0.18,
            0,
          );
          addWindowQuad(windows, start, end, edgeLengthMeters,
            bayStart + (bayWidth - apertureWidth) / 2, apertureWidth,
            storyBottom + sillHeight, apertureHeight, options, glass);
          windowCount++;
        }
      }
    }
  }

  const windowMesh = createWindowMesh(scene, windows);
  if (windowMesh) parts.push(windowMesh);

  return { parts, windowCount, floorCount };
}

function addWindowQuad(
  geometry: WindowGeometry,
  edgeStart: ScenePoint,
  edgeEnd: ScenePoint,
  edgeLengthMeters: number,
  offsetMeters: number,
  widthMeters: number,
  bottomElevation: number,
  heightMeters: number,
  options: BuildingRenderOptions,
  color: Color3,
): void {
  const directionX = (edgeEnd.x - edgeStart.x) * options.metersPerUnit / edgeLengthMeters;
  const directionZ = (edgeEnd.z - edgeStart.z) * options.metersPerUnit / edgeLengthMeters;
  const outwardX = directionZ;
  const outwardZ = -directionX;
  const offset = BUILDING_WALL_THICKNESS_METERS * 0.56 / options.metersPerUnit;
  const x0 = edgeStart.x + directionX * offsetMeters / options.metersPerUnit + outwardX * offset;
  const z0 = edgeStart.z + directionZ * offsetMeters / options.metersPerUnit + outwardZ * offset;
  const x1 = x0 + directionX * widthMeters / options.metersPerUnit;
  const z1 = z0 + directionZ * widthMeters / options.metersPerUnit;
  const y0 = bottomElevation / options.metersPerUnit;
  const y1 = (bottomElevation + heightMeters) / options.metersPerUnit;
  const first = geometry.positions.length / 3;
  geometry.positions.push(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0);
  geometry.indices.push(first, first + 2, first + 1, first, first + 3, first + 2);
  for (let vertex = 0; vertex < 4; vertex++) {
    geometry.normals.push(outwardX, 0, outwardZ);
    geometry.colors.push(color.r, color.g, color.b, 1);
  }
}

function createWindowMesh(scene: Scene, geometry: WindowGeometry): Mesh | undefined {
  if (geometry.indices.length === 0) return undefined;
  const mesh = stageBuildingMesh(new Mesh("buildingWindows", scene));
  const data = new VertexData();
  data.positions = geometry.positions;
  data.indices = geometry.indices;
  data.normals = geometry.normals;
  data.colors = geometry.colors;
  data.uvs = new Array<number>((geometry.positions.length / 3) * 2).fill(0);
  data.applyToMesh(mesh);
  mesh.useVertexColors = true;
  return mesh;
}

function addFacadePanel(
  parts: Mesh[],
  scene: Scene,
  edgeStart: ScenePoint,
  edgeEnd: ScenePoint,
  edgeLengthMeters: number,
  offsetMeters: number,
  widthMeters: number,
  bottomElevation: number,
  heightMeters: number,
  options: BuildingRenderOptions,
  color: Color3,
  thicknessMeters = BUILDING_WALL_THICKNESS_METERS,
  outwardOffsetMeters = 0,
): void {
  if (widthMeters <= 0.02 || heightMeters <= 0.02) return;
  const directionX = (edgeEnd.x - edgeStart.x) * options.metersPerUnit / edgeLengthMeters;
  const directionZ = (edgeEnd.z - edgeStart.z) * options.metersPerUnit / edgeLengthMeters;
  const centerAlongMeters = offsetMeters + widthMeters / 2;
  const panel = stageBuildingMesh(MeshBuilder.CreateBox("buildingFacadePanel", {
    width: widthMeters / options.metersPerUnit,
    height: heightMeters / options.metersPerUnit,
    depth: thicknessMeters / options.metersPerUnit,
  }, scene));
  panel.position.set(
    edgeStart.x + directionX * centerAlongMeters / options.metersPerUnit +
      directionZ * outwardOffsetMeters / options.metersPerUnit,
    (bottomElevation + heightMeters / 2) / options.metersPerUnit,
    edgeStart.z + directionZ * centerAlongMeters / options.metersPerUnit -
      directionX * outwardOffsetMeters / options.metersPerUnit,
  );
  panel.rotation.y = -Math.atan2(directionZ, directionX);
  setSolidVertexColor(panel, color);
  parts.push(panel);
}

function prepareBuildingFootprint(
  coordinates: LonLat[],
  terrain: TerrainData,
  options: BuildingRenderOptions,
): PreparedBuildingFootprint | undefined {
  const points = coordinates.map(([lon, lat]) =>
    lonLatToScene(lon, lat, terrain.bounds, options.meshWidth, options.meshDepth)
  );
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  const outline = clipPolygon(points, {
    minX: -options.meshWidth / 2,
    maxX: options.meshWidth / 2,
    minZ: -options.meshDepth / 2,
    maxZ: options.meshDepth / 2,
  });
  if (outline.length < 3) return undefined;
  if (signedArea(outline) < 0) outline.reverse();
  const center = averagePoint(outline);
  const elevations = [center, ...outline].map((point) =>
    sampleElevation(terrain, point.x, point.z, options.meshWidth, options.meshDepth)
  );
  if (elevations.some((elevation) => elevation <= SEA_LEVEL_METERS)) return undefined;
  return { outline, baseElevation: Math.max(...elevations) };
}

function createBuildingPrism(
  scene: Scene,
  outline: ScenePoint[],
  topElevation: number,
  bottomElevation: number,
  options: BuildingRenderOptions,
): Mesh {
  const shape = outline.map(({ x, z }) => new Vector2(x, z));
  const depth = Math.max(0.01, (topElevation - bottomElevation) / options.metersPerUnit);
  const mesh = stageBuildingMesh(
    new PolygonMeshBuilder("building", shape, scene, earcut).build(false, depth),
  );
  mesh.position.y = topElevation / options.metersPerUnit;
  return mesh;
}

function createRoofTrim(
  scene: Scene,
  outline: ScenePoint[],
  elevation: number,
  options: BuildingRenderOptions,
  color: Color3,
  detailSeed: number,
): Mesh | undefined {
  if (outline.length > 12) return undefined;
  const trimHeight = BUILDING_ROOF_TRIM_METERS +
    (seededUnit(detailSeed ^ 0x683a9f) - 0.5) * 0.16;
  const trim = createBuildingPrism(
    scene,
    outline,
    elevation + trimHeight / 2,
    elevation - trimHeight / 2,
    options,
  );
  const center = averagePoint(outline);
  const trimScale = 1.006 + seededUnit(detailSeed ^ 0x915cb4) * 0.016;
  const positions = trim.getVerticesData(VertexBuffer.PositionKind);
  if (positions) {
    for (let index = 0; index < positions.length; index += 3) {
      positions[index] = center.x + (positions[index] - center.x) * trimScale;
      positions[index + 2] = center.z + (positions[index + 2] - center.z) * trimScale;
    }
    trim.updateVerticesData(VertexBuffer.PositionKind, positions);
  }
  setSolidVertexColor(trim, color);
  return trim;
}

function createPitchedRoof(
  scene: Scene,
  outline: ScenePoint[],
  eaveElevation: number,
  peakElevation: number,
  roofShape: BuildingPlan["roofShape"],
  options: BuildingRenderOptions,
  color: Color3,
  detailSeed: number,
): Mesh | undefined {
  if (!isConvex(outline) || outline.length > 12) return undefined;
  const eaveY = eaveElevation / options.metersPerUnit;
  const peakY = peakElevation / options.metersPerUnit;
  const eaves = offsetConvexPolygon(
    outline,
    roofOverhangMeters(detailSeed) / options.metersPerUnit,
  );
  const vertices: Array<{ x: number; y: number; z: number }> = eaves.map((point) => ({
    x: point.x,
    y: eaveY,
    z: point.z,
  }));
  const indices: number[] = [];

  if (roofShape === "skillion" && eaves.length === 4) {
    const longestEdge = longestPolygonEdge(eaves);
    const order = [0, 1, 2, 3].map((offset) => (longestEdge + offset) % 4);
    const highStart = vertices.length;
    vertices.push(
      { x: eaves[order[0]].x, y: peakY, z: eaves[order[0]].z },
      { x: eaves[order[1]].x, y: peakY, z: eaves[order[1]].z },
    );
    addRoofFace(indices, [highStart, highStart + 1, order[2], order[3]]);
    addRoofFace(indices, [order[0], order[1], highStart + 1, highStart]);
    addRoofFace(indices, [order[1], order[2], highStart + 1]);
    addRoofFace(indices, [order[3], order[0], highStart]);
  } else if ((roofShape === "gabled" || roofShape === "hipped") && eaves.length === 4) {
    const longestEdge = longestPolygonEdge(eaves);
    const order = [0, 1, 2, 3].map((offset) => (longestEdge + offset) % 4);
    const corners = order.map((index) => eaves[index]);
    const left = midpoint(corners[3], corners[0]);
    const right = midpoint(corners[1], corners[2]);
    const inset = roofShape === "hipped"
      ? Math.min(0.32, pointDistance(corners[0], corners[3]) / Math.max(0.01, pointDistance(left, right) * 2))
      : 0;
    const ridgeLeft = lerpPoint(left, right, inset);
    const ridgeRight = lerpPoint(left, right, 1 - inset);
    const ridgeStart = vertices.length;
    vertices.push(
      { x: ridgeLeft.x, y: peakY, z: ridgeLeft.z },
      { x: ridgeRight.x, y: peakY, z: ridgeRight.z },
    );
    addRoofFace(indices, [order[0], order[1], ridgeStart + 1, ridgeStart]);
    addRoofFace(indices, [order[2], order[3], ridgeStart, ridgeStart + 1]);
    addRoofFace(indices, [order[1], order[2], ridgeStart + 1]);
    addRoofFace(indices, [order[3], order[0], ridgeStart]);
  } else {
    const center = polygonCentroid(eaves);
    const peak = vertices.length;
    vertices.push({ x: center.x, y: peakY, z: center.z });
    for (let index = 0; index < eaves.length; index++) {
      addRoofFace(indices, [index, (index + 1) % eaves.length, peak]);
    }
  }

  const positions = vertices.flatMap((vertex) => [vertex.x, vertex.y, vertex.z]);
  const normals = new Array<number>(positions.length).fill(0);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.uvs = new Array<number>(vertices.length * 2).fill(0);
  const roof = stageBuildingMesh(new Mesh("buildingRoof", scene));
  data.applyToMesh(roof);
  roof.convertToFlatShadedMesh();
  colorRoofMesh(roof, color);
  return roof;
}

function createRooftopVolume(
  scene: Scene,
  plan: BuildingPlan,
  outline: ScenePoint[],
  roofElevation: number,
  areaSquareMeters: number,
  options: BuildingRenderOptions,
  appearance: BuildingAppearance,
): Mesh | undefined {
  const variation = seededUnit(plan.detailSeed ^ 0x51f15e);
  if (areaSquareMeters < 260 || plan.heightMeters < 10 || variation > 0.46 || !isConvex(outline)) {
    return undefined;
  }
  const bounds = polygonBounds(outline);
  const heightMeters = 1.2 + seededUnit(plan.detailSeed ^ 0x2a97) * 1.4;
  const rooftop = stageBuildingMesh(MeshBuilder.CreateBox("buildingRooftop", {
    width: Math.max(1.2 / options.metersPerUnit, (bounds.maxX - bounds.minX) * 0.22),
    depth: Math.max(1.2 / options.metersPerUnit, (bounds.maxZ - bounds.minZ) * 0.22),
    height: heightMeters / options.metersPerUnit,
  }, scene));
  const center = polygonCentroid(outline);
  rooftop.position.set(
    center.x,
    (roofElevation + heightMeters / 2) / options.metersPerUnit,
    center.z,
  );
  setSolidVertexColor(rooftop, appearance.trim);
  return rooftop;
}

function inferredRoofHeight(
  outline: ScenePoint[],
  areaSquareMeters: number,
  options: BuildingRenderOptions,
  detailSeed: number,
): number {
  const spanMeters = outline.length === 4
    ? Math.min(
      (pointDistance(outline[0], outline[1]) + pointDistance(outline[2], outline[3])) / 2,
      (pointDistance(outline[1], outline[2]) + pointDistance(outline[3], outline[0])) / 2,
    ) * options.metersPerUnit
    : Math.sqrt(areaSquareMeters);
  const pitchDegrees = 32 + seededUnit(detailSeed ^ 0x46a31d) * 16;
  const rise = spanMeters / 2 * Math.tan(pitchDegrees * Math.PI / 180);
  return Math.max(1.8, Math.min(6, rise));
}

function roofOverhangMeters(detailSeed: number): number {
  return BUILDING_ROOF_OVERHANG_METERS +
    (seededUnit(detailSeed ^ 0x31bd72) - 0.5) * 0.3;
}

function resolvedRoofShape(
  plan: BuildingPlan,
  outline: ScenePoint[],
  areaSquareMeters: number,
): BuildingPlan["roofShape"] {
  if (plan.roofShape !== "unknown") {
    if (plan.roofShape === "flat") return "flat";
    return isConvex(outline) && outline.length <= 12 ? plan.roofShape : "flat";
  }
  if (outline.length !== 4 || !isConvex(outline) || areaSquareMeters > 650 || plan.heightMeters > 16) {
    return "flat";
  }
  const variation = seededUnit(plan.detailSeed ^ 0x7a4d2b);
  if (variation < 0.34) return "gabled";
  if (variation < 0.58) return "hipped";
  if (variation < 0.72) return "skillion";
  if (variation < 0.84) return "pyramidal";
  return "flat";
}

function buildingAppearance(plan: BuildingPlan): BuildingAppearance {
  const palettes: Array<{ wall: string; roof: string }> = [
    { wall: "#d7d0c1", roof: "#655b52" },
    { wall: "#c89677", roof: "#74483a" },
    { wall: "#bdc3b5", roof: "#59645d" },
    { wall: "#d9c590", roof: "#6f5742" },
    { wall: "#bbc6cc", roof: "#4f5d64" },
    { wall: "#d3b6a7", roof: "#76524a" },
    { wall: "#e0ded5", roof: "#667079" },
    { wall: "#b8aa93", roof: "#5f5144" },
  ];
  const materialColors: Record<string, string> = {
    brick: "#a66f59",
    concrete: "#b9b7b1",
    cement_block: "#aaa9a3",
    glass: "#8299a3",
    metal: "#9da6a8",
    plaster: "#d8d2c5",
    stone: "#aaa08e",
    wood: "#a98263",
  };
  const palette = palettes[Math.abs(plan.detailSeed) % palettes.length];
  const baseWall = parseBuildingColor(plan.wallColor) ??
    parseBuildingColor(plan.wallMaterial ? materialColors[plan.wallMaterial] : undefined) ??
    parseBuildingColor(palette.wall)!;
  const baseRoof = parseBuildingColor(plan.roofColor) ??
    parseBuildingColor(plan.roofMaterial ? materialColors[plan.roofMaterial] : undefined) ??
    parseBuildingColor(palette.roof)!;
  const wall = varyColor(
    baseWall,
    seededUnit(plan.detailSeed ^ 0x128fa3) - 0.5,
    seededUnit(plan.detailSeed ^ 0x74c921) - 0.5,
  );
  const roof = varyColor(
    baseRoof,
    seededUnit(plan.detailSeed ^ 0x5e219b) - 0.5,
    seededUnit(plan.detailSeed ^ 0x2794df) - 0.5,
  );
  return { wall, roof, trim: mixColor(wall, roof, 0.72) };
}

function parseBuildingColor(value: string | undefined): Color3 | undefined {
  if (!value) return undefined;
  const named: Record<string, string> = {
    beige: "#d8cfb5",
    black: "#242526",
    blue: "#6e8799",
    brown: "#806553",
    gray: "#a6a6a2",
    grey: "#a6a6a2",
    green: "#78907b",
    red: "#aa6256",
    silver: "#b8bcbb",
    white: "#e6e4dc",
    yellow: "#d8c77e",
  };
  let hexadecimal = named[value] ?? value;
  if (/^#[0-9a-f]{3}$/i.test(hexadecimal)) {
    hexadecimal = `#${hexadecimal[1]}${hexadecimal[1]}${hexadecimal[2]}${hexadecimal[2]}${hexadecimal[3]}${hexadecimal[3]}`;
  }
  if (!/^#[0-9a-f]{6}$/i.test(hexadecimal)) return undefined;
  return new Color3(
    Number.parseInt(hexadecimal.slice(1, 3), 16) / 255,
    Number.parseInt(hexadecimal.slice(3, 5), 16) / 255,
    Number.parseInt(hexadecimal.slice(5, 7), 16) / 255,
  );
}

function colorBuildingMass(mesh: Mesh, appearance: BuildingAppearance): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!positions) return;
  const colors: number[] = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const normalX = normals?.[vertex * 3] ?? 0;
    const normalY = normals?.[vertex * 3 + 1] ?? 0;
    const normalZ = normals?.[vertex * 3 + 2] ?? 0;
    const base = normalY > 0.55 ? appearance.roof : appearance.wall;
    const light = normalY > 0.55
      ? 1
      : Math.max(0.7, Math.min(1.03, 0.84 + normalX * 0.11 - normalZ * 0.07));
    colors.push(
      clamp01(base.r * light),
      clamp01(base.g * light),
      clamp01(base.b * light),
      1,
    );
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  mesh.useVertexColors = true;
}

function colorRoofMesh(mesh: Mesh, color: Color3): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!positions) return;
  const colors: number[] = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const normalX = Math.abs(normals?.[vertex * 3] ?? 0);
    const normalZ = Math.abs(normals?.[vertex * 3 + 2] ?? 0);
    const light = 0.86 + normalX * 0.08 + normalZ * 0.04;
    colors.push(color.r * light, color.g * light, color.b * light, 1);
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  mesh.useVertexColors = true;
}

function setSolidVertexColor(mesh: Mesh, color: Color3): void {
  const count = mesh.getTotalVertices();
  const colors = new Array<number>(count * 4);
  for (let vertex = 0; vertex < count; vertex++) {
    colors[vertex * 4] = color.r;
    colors[vertex * 4 + 1] = color.g;
    colors[vertex * 4 + 2] = color.b;
    colors[vertex * 4 + 3] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  mesh.useVertexColors = true;
}

function seededUnit(seed: number): number {
  let value = seed | 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

function pointDistance(a: ScenePoint, b: ScenePoint): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function longestPolygonEdge(points: ScenePoint[]): number {
  let longest = 0;
  for (let index = 1; index < points.length; index++) {
    if (
      pointDistance(points[index], points[(index + 1) % points.length]) >
      pointDistance(points[longest], points[(longest + 1) % points.length])
    ) {
      longest = index;
    }
  }
  return longest;
}

/** Expands a counter-clockwise convex ring to create a physical roof eave. */
function offsetConvexPolygon(points: ScenePoint[], distance: number): ScenePoint[] {
  return points.map((point, index) => {
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    const incomingLength = pointDistance(previous, point) || 1;
    const outgoingLength = pointDistance(point, next) || 1;
    const incomingNormal = {
      x: (point.z - previous.z) / incomingLength,
      z: -(point.x - previous.x) / incomingLength,
    };
    const outgoingNormal = {
      x: (next.z - point.z) / outgoingLength,
      z: -(next.x - point.x) / outgoingLength,
    };
    const miterX = incomingNormal.x + outgoingNormal.x;
    const miterZ = incomingNormal.z + outgoingNormal.z;
    const miterLength = Math.hypot(miterX, miterZ);
    if (miterLength < 1e-6) {
      return {
        x: point.x + outgoingNormal.x * distance,
        z: point.z + outgoingNormal.z * distance,
      };
    }
    const directionX = miterX / miterLength;
    const directionZ = miterZ / miterLength;
    const alignment = directionX * outgoingNormal.x + directionZ * outgoingNormal.z;
    const offset = Math.min(distance * 3, distance / Math.max(0.34, alignment));
    return {
      x: point.x + directionX * offset,
      z: point.z + directionZ * offset,
    };
  });
}

function midpoint(a: ScenePoint, b: ScenePoint): ScenePoint {
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
}

function lerpPoint(a: ScenePoint, b: ScenePoint, amount: number): ScenePoint {
  return { x: a.x + (b.x - a.x) * amount, z: a.z + (b.z - a.z) * amount };
}

function addRoofFace(indices: number[], face: number[]): void {
  for (let index = 1; index < face.length - 1; index++) {
    indices.push(face[0], face[index + 1], face[index]);
  }
}

function isConvex(points: ScenePoint[]): boolean {
  if (points.length < 3) return false;
  let direction = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const c = points[(index + 2) % points.length];
    const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cross) < 1e-8) continue;
    const sign = Math.sign(cross);
    if (direction !== 0 && sign !== direction) return false;
    direction = sign;
  }
  return direction !== 0;
}

function polygonCentroid(points: ScenePoint[]): ScenePoint {
  let area = 0;
  let x = 0;
  let z = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    const cross = points[index].x * next.z - next.x * points[index].z;
    area += cross;
    x += (points[index].x + next.x) * cross;
    z += (points[index].z + next.z) * cross;
  }
  return Math.abs(area) < 1e-8
    ? averagePoint(points)
    : { x: x / (3 * area), z: z / (3 * area) };
}

function polygonBounds(points: ScenePoint[]): Bounds {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    maxX: Math.max(bounds.maxX, point.x),
    minZ: Math.min(bounds.minZ, point.z),
    maxZ: Math.max(bounds.maxZ, point.z),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
}

function clipPolygon(points: ScenePoint[], bounds: Bounds): ScenePoint[] {
  const edges: Array<{
    inside: (point: ScenePoint) => boolean;
    intersect: (start: ScenePoint, end: ScenePoint) => ScenePoint;
  }> = [
    { inside: (point) => point.x >= bounds.minX, intersect: (a, b) => atX(a, b, bounds.minX) },
    { inside: (point) => point.x <= bounds.maxX, intersect: (a, b) => atX(a, b, bounds.maxX) },
    { inside: (point) => point.z >= bounds.minZ, intersect: (a, b) => atZ(a, b, bounds.minZ) },
    { inside: (point) => point.z <= bounds.maxZ, intersect: (a, b) => atZ(a, b, bounds.maxZ) },
  ];
  let output = points;
  for (const edge of edges) {
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index++) {
      const start = input[(index + input.length - 1) % input.length];
      const end = input[index];
      const startInside = edge.inside(start);
      const endInside = edge.inside(end);
      if (endInside) {
        if (!startInside) output.push(edge.intersect(start, end));
        output.push(end);
      } else if (startInside) {
        output.push(edge.intersect(start, end));
      }
    }
  }
  return output;
}

function atX(start: ScenePoint, end: ScenePoint, x: number): ScenePoint {
  const amount = (x - start.x) / (end.x - start.x);
  return { x, z: start.z + amount * (end.z - start.z) };
}

function atZ(start: ScenePoint, end: ScenePoint, z: number): ScenePoint {
  const amount = (z - start.z) / (end.z - start.z);
  return { x: start.x + amount * (end.x - start.x), z };
}

function signedArea(points: ScenePoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.z - next.x * points[index].z;
  }
  return area / 2;
}

function averagePoint(points: ScenePoint[]): ScenePoint {
  const total = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, z: sum.z + point.z }),
    { x: 0, z: 0 },
  );
  return { x: total.x / points.length, z: total.z / points.length };
}

function samePoint(a: ScenePoint, b: ScenePoint): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6;
}

function mixColor(a: Color3, b: Color3, amount: number): Color3 {
  return new Color3(
    a.r + (b.r - a.r) * amount,
    a.g + (b.g - a.g) * amount,
    a.b + (b.b - a.b) * amount,
  );
}

function varyColor(color: Color3, tone: number, warmth: number): Color3 {
  const light = 1 + tone * 0.16;
  return new Color3(
    clamp01(color.r * light + warmth * 0.035),
    clamp01(color.g * light + warmth * 0.008),
    clamp01(color.b * light - warmth * 0.025),
  );
}

function stageBuildingMesh<T extends Mesh>(mesh: T): T {
  mesh.setEnabled(false);
  return mesh;
}
