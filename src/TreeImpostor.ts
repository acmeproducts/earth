import {
  Mesh,
  Scene,
  VertexBuffer,
} from "@babylonjs/core";
import {
  createProceduralTree,
  PROCEDURAL_TREE_CAPTURE_DIAMETER,
  PROCEDURAL_TREE_SOURCE_HEIGHT,
} from "./ProceduralTree";
import { setVertexColorModelHeight } from "./ProceduralCaptureMaterial";
import {
  createImpostorAssetProvider,
  IMPOSTOR_CUBE_FACES,
  ImpostorAssets,
} from "./Impostor";

export type TreeImpostorAssets = ImpostorAssets;
export { IMPOSTOR_CUBE_FACES as TREE_IMPOSTOR_FACES } from "./Impostor";

const treeImpostors = createImpostorAssetProvider({
  name: "treeImpostor",
  queryPrefix: "tree-impostor",
  createSource: (scene) => createProceduralTree(scene),
  sourceHeight: PROCEDURAL_TREE_SOURCE_HEIGHT,
  captureDiameter: PROCEDURAL_TREE_CAPTURE_DIAMETER,
  boundsPadding: 1.04,
  preserveCaptureAspectRatio: true,
  minimumResolutionWidth: 64,
  faces: IMPOSTOR_CUBE_FACES,
  sampling: {
    horizontalSamples: { default: 10, minimum: 1, maximum: 16 },
    verticalSamples: { default: 5, minimum: 1, maximum: 10 },
    resolution: { default: 1000, minimum: 64, maximum: 1024 },
  },
});

/** Shares one tree atlas capture per scene and capture-attribute combination. */
export function getTreeImpostorAssets(
  scene: Scene,
  horizontalSamples = treeImpostors.getDefaultSampling().horizontalSamples,
  verticalSamples = treeImpostors.getDefaultSampling().verticalSamples,
  resolution = treeImpostors.getDefaultSampling().resolution,
): Promise<TreeImpostorAssets> {
  return treeImpostors.getAssets(scene, {
    horizontalSamples,
    verticalSamples,
    resolution,
  });
}

/** Builds the original procedural geometry at the requested rendered height. */
export async function createTreeModels(
  scene: Scene,
  renderHeight: number,
): Promise<Mesh[]> {
  const tree = createProceduralTree(scene, {
    name: "treeModels",
    liveLighting: true,
  });
  const positions = tree.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) throw new Error("Procedural tree has no position data.");

  const renderScale = renderHeight / PROCEDURAL_TREE_SOURCE_HEIGHT;
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] *= renderScale;
    positions[index + 1] = positions[index + 1] * renderScale + renderHeight / 2;
    positions[index + 2] *= renderScale;
  }
  tree.setVerticesData(VertexBuffer.PositionKind, positions);
  tree.refreshBoundingInfo();
  setVertexColorModelHeight(tree, renderHeight);
  return [tree];
}
