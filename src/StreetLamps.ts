import {
  Color3,
  Matrix,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { sampleElevation } from "./Geo";
import type { PlannedStreetLamp } from "./RoadAndBuildingPlanner";
import type { TerrainData } from "./TerrainData";

interface StreetLampOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  startDisabled?: boolean;
}

export interface StreetLampLayer {
  root: TransformNode;
  count: number;
  mappedCount: number;
  proceduralCount: number;
}

/**
 * Builds the street-lamp placements prepared by the road/building planner.
 * Lamps are emissive geometry rather than PointLights: hundreds of dynamic
 * lights would make streamed tiles prohibitively costly.
 */
export class StreetLamps {
  static createLayer(
    scene: Scene,
    planned: readonly PlannedStreetLamp[],
    terrain: TerrainData,
    options: StreetLampOptions,
  ): StreetLampLayer {
    const root = new TransformNode("streetLamps", scene);
    if (options.startDisabled) root.setEnabled(false);
    const placements: Array<{ x: number; z: number; angle: number }> = [];
    let mappedCount = 0;
    for (const lamp of planned) {
      const point = lamp.position;
      if (!inside(point, options)) continue;
      if (lamp.source === "mapped") mappedCount++;
      placements.push({ x: point.x, z: point.z, angle: lamp.orientationRadians });
    }

    if (placements.length > 0) createLampMeshes(scene, root, placements, terrain, options);
    return {
      root,
      count: placements.length,
      mappedCount,
      proceduralCount: placements.length - mappedCount,
    };
  }
}

function createLampMeshes(
  scene: Scene,
  root: TransformNode,
  placements: readonly { x: number; z: number; angle: number }[],
  terrain: TerrainData,
  options: StreetLampOptions,
): void {
  const scale = 1 / options.metersPerUnit;
  const pole = MeshBuilder.CreateCylinder("streetLampPoles", { height: 6.4 * scale, diameter: 0.12 * scale, tessellation: 6 }, scene);
  const head = MeshBuilder.CreateSphere("streetLampHeads", { diameter: 0.32 * scale, segments: 8 }, scene);
  const shade = MeshBuilder.CreateCylinder("streetLampShades", {
    height: 0.18 * scale,
    diameterTop: 0.22 * scale,
    diameterBottom: 0.52 * scale,
    tessellation: 10,
  }, scene);
  const poleMaterial = new StandardMaterial("streetLampPoleMaterial", scene);
  poleMaterial.diffuseColor = new Color3(0.075, 0.085, 0.085);
  poleMaterial.specularColor = new Color3(0.12, 0.12, 0.11);
  const headMaterial = new StandardMaterial("streetLampHeadMaterial", scene);
  // The fixtures are deliberately off. A muted lens remains visible without
  // creating the daytime orange glow of an illuminated street lamp.
  headMaterial.diffuseColor = new Color3(0.38, 0.34, 0.25);
  headMaterial.specularColor = new Color3(0.16, 0.13, 0.08);
  const shadeMaterial = new StandardMaterial("streetLampShadeMaterial", scene);
  shadeMaterial.diffuseColor = new Color3(0.045, 0.05, 0.05);
  shadeMaterial.specularColor = new Color3(0.1, 0.11, 0.11);
  pole.material = poleMaterial;
  head.material = headMaterial;
  shade.material = shadeMaterial;
  pole.parent = root;
  head.parent = root;
  shade.parent = root;
  pole.isPickable = false;
  head.isPickable = false;
  shade.isPickable = false;
  // Thin-instance matrices are relative to this source mesh. Keep the source
  // transform at the origin: moving it to hide its base copy would move every
  // lamp below the terrain as well.
  const poleMatrices: Matrix[] = [];
  const headMatrices: Matrix[] = [];
  const shadeMatrices: Matrix[] = [];
  for (const placement of placements) {
    const elevation = sampleElevation(terrain, placement.x, placement.z, options.meshWidth, options.meshDepth) / options.metersPerUnit;
    poleMatrices.push(Matrix.Compose(Vector3.One(), Quaternion.Identity(), new Vector3(placement.x, elevation + 3.2 * scale, placement.z)));
    headMatrices.push(Matrix.Compose(Vector3.One(), Quaternion.Identity(), new Vector3(placement.x, elevation + 6.35 * scale, placement.z)));
    shadeMatrices.push(Matrix.Compose(Vector3.One(), Quaternion.Identity(), new Vector3(placement.x, elevation + 6.53 * scale, placement.z)));
  }
  pole.thinInstanceAdd(poleMatrices);
  head.thinInstanceAdd(headMatrices);
  shade.thinInstanceAdd(shadeMatrices);
}

function inside(point: { x: number; z: number }, options: StreetLampOptions): boolean {
  return Math.abs(point.x) <= options.meshWidth / 2 && Math.abs(point.z) <= options.meshDepth / 2;
}
