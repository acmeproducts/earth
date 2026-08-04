import {
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { createNoise2D } from "simplex-noise";
import { TerrainResult } from "./TerrainTiles";

export interface TreeFieldResult {
  root: TransformNode;
  meshes: Mesh[];
  count: number;
}

interface TreeFieldOptions {
  meshWidth: number;
  meshDepth: number;
  metersPerUnit: number;
  seed?: number;
  spacingMeters?: number;
  waterLineMeters?: number;
}

/** Creates a low-poly placeholder forest distributed by seeded simplex noise. */
export function createTreeField(
  scene: Scene,
  terrain: TerrainResult,
  options: TreeFieldOptions,
): TreeFieldResult {
  const {
    meshWidth,
    meshDepth,
    metersPerUnit,
    seed = 0x4f534c4f,
    spacingMeters = 5,
    waterLineMeters = 0,
  } = options;
  const root = new TransformNode("treeField", scene);

  const treeHeight = 11 / metersPerUnit;
  const trunkHeight = treeHeight * 0.38;
  const trunk = MeshBuilder.CreateCylinder(
    "treeTrunks",
    {
      height: trunkHeight,
      diameterTop: treeHeight * 0.065,
      diameterBottom: treeHeight * 0.09,
      tessellation: 6,
    },
    scene,
  );
  trunk.position.y = trunkHeight / 2;
  trunk.bakeCurrentTransformIntoVertices();

  const canopyHeight = treeHeight * 0.78;
  const canopy = MeshBuilder.CreateCylinder(
    "treeCanopies",
    {
      height: canopyHeight,
      diameterTop: 0,
      diameterBottom: treeHeight * 0.45,
      tessellation: 7,
    },
    scene,
  );
  canopy.position.y = trunkHeight + canopyHeight * 0.38;
  canopy.bakeCurrentTransformIntoVertices();

  const trunkMaterial = new StandardMaterial("treeTrunkMaterial", scene);
  trunkMaterial.diffuseColor = new Color3(0.28, 0.15, 0.07);
  trunkMaterial.specularColor = Color3.Black();
  trunk.material = trunkMaterial;

  const canopyMaterial = new StandardMaterial("treeCanopyMaterial", scene);
  canopyMaterial.diffuseColor = new Color3(0.08, 0.3, 0.1);
  canopyMaterial.specularColor = Color3.Black();
  canopy.material = canopyMaterial;

  trunk.parent = root;
  canopy.parent = root;

  const random = mulberry32(seed);
  const noise = createNoise2D(random);
  const spacing = spacingMeters / metersPerUnit;
  const columns = Math.max(1, Math.floor(meshWidth / spacing));
  const rows = Math.max(1, Math.floor(meshDepth / spacing));
  const cellWidth = meshWidth / columns;
  const cellDepth = meshDepth / rows;
  const matrices: Matrix[] = [];

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = -meshWidth / 2 + (column + 0.2 + random() * 0.6) * cellWidth;
      const z = meshDepth / 2 - (row + 0.2 + random() * 0.6) * cellDepth;
      const elevation = sampleElevation(terrain, x, z, meshWidth, meshDepth);
      if (elevation <= waterLineMeters) continue;

      // Two scales produce broad forest regions with some local variation.
      const worldX = x * metersPerUnit;
      const worldZ = z * metersPerUnit;
      const density =
        noise(worldX / 260, worldZ / 260) * 0.72 +
        noise(worldX / 75, worldZ / 75) * 0.28;
      if (density + (random() - 0.5) * 0.3 < -0.08) continue;

      const heightScale = 0.75 + random() * 0.5;
      const widthScale = 0.75 + random() * 0.35;
      matrices.push(
        Matrix.Compose(
          new Vector3(widthScale, heightScale, widthScale),
          Vector3.Up()
            .scale((random() - 0.5) * Math.PI * 2)
            .toQuaternion(),
          new Vector3(x, elevation / metersPerUnit, z),
        ),
      );
    }
  }

  const matrixData = new Float32Array(matrices.length * 16);
  matrices.forEach((matrix, index) =>
    matrix.copyToArray(matrixData, index * 16),
  );
  trunk.thinInstanceSetBuffer("matrix", matrixData, 16, true);
  canopy.thinInstanceSetBuffer("matrix", matrixData, 16, true);
  trunk.setEnabled(matrices.length > 0);
  canopy.setEnabled(matrices.length > 0);
  trunk.freezeWorldMatrix();
  canopy.freezeWorldMatrix();

  return { root, meshes: [trunk, canopy], count: matrices.length };
}

function sampleElevation(
  terrain: TerrainResult,
  x: number,
  z: number,
  meshWidth: number,
  meshDepth: number,
): number {
  const u = Math.min(1, Math.max(0, x / meshWidth + 0.5));
  const v = Math.min(1, Math.max(0, 0.5 - z / meshDepth));
  const px = u * (terrain.width - 1);
  const py = v * (terrain.height - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, terrain.width - 1);
  const y1 = Math.min(y0 + 1, terrain.height - 1);
  const fx = px - x0;
  const fy = py - y0;

  const e00 = terrain.elevations[y0 * terrain.width + x0];
  const e10 = terrain.elevations[y0 * terrain.width + x1];
  const e01 = terrain.elevations[y1 * terrain.width + x0];
  const e11 = terrain.elevations[y1 * terrain.width + x1];
  return (
    e00 * (1 - fx) * (1 - fy) +
    e10 * fx * (1 - fy) +
    e01 * (1 - fx) * fy +
    e11 * fx * fy
  );
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
