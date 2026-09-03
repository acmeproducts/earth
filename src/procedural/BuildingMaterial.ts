import { Color3, Mesh, Scene, StandardMaterial, VertexBuffer } from "@babylonjs/core";
import { CustomMaterial } from "@babylonjs/materials/custom/customMaterial.js";
import type { BuildingClass, BuildingRoofShape } from "../BuildingPlanner";

// UV2 survives Babylon's Mesh.MergeMeshes path; the building geometry does not
// otherwise use a second UV channel.
export const BUILDING_MATERIAL_VERTEX_KIND = VertexBuffer.UV2Kind;

export type BuildingSurface =
  | "plaster"
  | "brick"
  | "concrete"
  | "stone"
  | "wood"
  | "metal"
  | "roof-tile"
  | "roof-slate"
  | "roof-metal"
  | "roof-flat";

const SURFACE_IDS: Readonly<Record<BuildingSurface, number>> = {
  plaster: 0,
  brick: 1,
  concrete: 2,
  stone: 3,
  wood: 4,
  metal: 5,
  "roof-tile": 6,
  "roof-slate": 7,
  "roof-metal": 8,
  "roof-flat": 9,
};

const WALL_MATERIALS: Readonly<Record<string, BuildingSurface>> = {
  brick: "brick",
  bricks: "brick",
  concrete: "concrete",
  cement_block: "concrete",
  block: "concrete",
  stone: "stone",
  masonry: "stone",
  sandstone: "stone",
  limestone: "stone",
  wood: "wood",
  timber: "wood",
  metal: "metal",
  steel: "metal",
  plaster: "plaster",
  stucco: "plaster",
  render: "plaster",
  glass: "metal",
};

const ROOF_MATERIALS: Readonly<Record<string, BuildingSurface>> = {
  tile: "roof-tile",
  tiles: "roof-tile",
  roof_tiles: "roof-tile",
  clay: "roof-tile",
  slate: "roof-slate",
  stone: "roof-slate",
  metal: "roof-metal",
  steel: "roof-metal",
  zinc: "roof-metal",
  copper: "roof-metal",
  concrete: "roof-flat",
  asphalt: "roof-flat",
  bitumen: "roof-flat",
  tar_paper: "roof-flat",
};

export function wallSurfaceFor(
  material: string | undefined,
  buildingClass: BuildingClass,
  detailSeed: number,
): BuildingSurface {
  if (material && WALL_MATERIALS[material]) return WALL_MATERIALS[material];
  switch (buildingClass) {
    case "residential": return Math.abs(detailSeed) % 3 === 0 ? "brick" : "plaster";
    case "commercial": return "concrete";
    case "industrial":
    case "warehouse": return "metal";
    case "garage":
    case "utility": return "concrete";
    case "education": return "brick";
    case "medical": return "plaster";
    case "religious": return "stone";
    default: return ["plaster", "brick", "concrete"][Math.abs(detailSeed) % 3] as BuildingSurface;
  }
}

export function roofSurfaceFor(
  material: string | undefined,
  roofShape: BuildingRoofShape,
  buildingClass: BuildingClass,
): BuildingSurface {
  if (material && ROOF_MATERIALS[material]) return ROOF_MATERIALS[material];
  if (roofShape === "flat" || buildingClass === "commercial" || buildingClass === "industrial") {
    return "roof-flat";
  }
  if (buildingClass === "warehouse" || buildingClass === "garage" || buildingClass === "utility") {
    return "roof-metal";
  }
  return buildingClass === "religious" ? "roof-slate" : "roof-tile";
}

export function setBuildingSurface(mesh: Mesh, surface: BuildingSurface): void {
  mesh.setVerticesData(
    BUILDING_MATERIAL_VERTEX_KIND,
    Array.from({ length: mesh.getTotalVertices() }, () => [SURFACE_IDS[surface], 0]).flat(),
    false,
    2,
  );
}

export function setBuildingSurfaces(
  mesh: Mesh,
  surfaces: (normalY: number) => BuildingSurface,
): void {
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  const values = new Array<number>(mesh.getTotalVertices() * 2);
  for (let vertex = 0; vertex < mesh.getTotalVertices(); vertex++) {
    values[vertex * 2] = SURFACE_IDS[surfaces(normals?.[vertex * 3 + 1] ?? 0)];
    values[vertex * 2 + 1] = 0;
  }
  mesh.setVerticesData(BUILDING_MATERIAL_VERTEX_KIND, values, false, 2);
}

/** A small analytic palette keeps detailed facades legible without image assets or extra draw calls. */
export function createBuildingSolidMaterial(
  name: string,
  scene: Scene,
  metersPerUnit: number,
): StandardMaterial {
  const material = new CustomMaterial(name, scene);
  material.diffuseColor = Color3.White();
  material.specularColor = new Color3(0.025, 0.025, 0.025);
  material.specularPower = 16;
  material.backFaceCulling = false;
  material.AddAttribute(BUILDING_MATERIAL_VERTEX_KIND);
  material.AddUniform("buildingMetersPerUnit", "float", metersPerUnit);
  material.Vertex_Definitions(`
    attribute vec2 ${BUILDING_MATERIAL_VERTEX_KIND};
    varying float vBuildingMaterial;
  `);
  material.Vertex_MainEnd(`vBuildingMaterial = ${BUILDING_MATERIAL_VERTEX_KIND}.x;`);
  material.Fragment_Definitions(`
    varying float vBuildingMaterial;

    float buildingLine(float coordinate, float interval, float width) {
      float edge = abs(fract(coordinate / interval) - 0.5) * interval;
      return 1.0 - smoothstep(width * 0.55, width, edge);
    }

    float buildingHash(vec2 point) {
      return fract(sin(dot(floor(point), vec2(127.1, 311.7))) * 43758.5453);
    }
  `);
  material.Fragment_Custom_Diffuse(`
    vec3 buildingPosition = vPositionW * buildingMetersPerUnit;
    vec2 buildingUv = abs(normalW.y) > 0.62
      ? buildingPosition.xz
      : (abs(normalW.x) > abs(normalW.z) ? buildingPosition.zy : buildingPosition.xy);
    float buildingKind = floor(vBuildingMaterial + 0.5);
    float buildingShade = 1.0;

    if (buildingKind == 0.0) {
      buildingShade = 0.96 + 0.06 * buildingHash(buildingUv * 3.0);
    } else if (buildingKind == 1.0) {
      float row = floor(buildingUv.y / 0.075);
      float mortarX = buildingLine(buildingUv.x + mod(row, 2.0) * 0.12, 0.24, 0.012);
      float mortarY = buildingLine(buildingUv.y, 0.075, 0.009);
      buildingShade = mix(0.72, 0.98 + 0.08 * buildingHash(vec2(floor(buildingUv.x / 0.24), row)),
        max(mortarX, mortarY));
    } else if (buildingKind == 2.0) {
      float joint = max(buildingLine(buildingUv.x, 2.4, 0.025), buildingLine(buildingUv.y, 1.2, 0.025));
      buildingShade = mix(0.8, 0.94 + 0.08 * buildingHash(buildingUv * 5.0), joint);
    } else if (buildingKind == 3.0) {
      float course = buildingLine(buildingUv.y, 0.28, 0.016);
      float block = buildingLine(buildingUv.x + mod(floor(buildingUv.y / 0.28), 2.0) * 0.3, 0.6, 0.018);
      buildingShade = mix(0.74, 0.9 + 0.16 * buildingHash(buildingUv * vec2(1.7, 3.5)), max(course, block));
    } else if (buildingKind == 4.0) {
      float seam = buildingLine(buildingUv.x, 0.18, 0.012);
      float grain = 0.04 * sin(buildingUv.y * 31.0 + buildingHash(vec2(floor(buildingUv.x / 0.18), 0.0)) * 6.28);
      buildingShade = mix(0.68, 0.98 + grain, seam);
    } else if (buildingKind == 5.0) {
      float rib = pow(abs(sin(buildingUv.x * 3.14159 / 0.22)), 10.0);
      buildingShade = 0.82 + rib * 0.2;
    } else if (buildingKind == 6.0) {
      float row = floor(buildingUv.y / 0.32);
      float seam = max(buildingLine(buildingUv.y, 0.32, 0.018),
        buildingLine(buildingUv.x + mod(row, 2.0) * 0.18, 0.36, 0.014));
      buildingShade = mix(0.72, 1.02, seam);
    } else if (buildingKind == 7.0) {
      float seam = max(buildingLine(buildingUv.y, 0.25, 0.012), buildingLine(buildingUv.x, 0.3, 0.01));
      buildingShade = mix(0.7, 0.98, seam);
    } else if (buildingKind == 8.0) {
      buildingShade = 0.82 + 0.2 * pow(abs(sin(buildingUv.x * 3.14159 / 0.38)), 12.0);
    } else {
      buildingShade = 0.92 + 0.08 * buildingHash(buildingUv * 2.0);
    }
    result *= buildingShade;
  `);
  return material;
}
