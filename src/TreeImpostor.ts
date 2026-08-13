import {
  Mesh,
  Scene,
  VertexBuffer,
} from "@babylonjs/core";
import {
  measureFoliageTextures,
  TREE_SPECIES,
  TREE_SPECIES_LIST,
  TreeSpecies,
} from "./ProceduralTree";
import { setVertexColorModelHeight } from "./ProceduralCaptureMaterial";
import {
  createImpostorAssetProvider,
  IMPOSTOR_CUBE_FACES,
  ImpostorAssets,
} from "./Impostor";

export type TreeImpostorAssets = ImpostorAssets;
export { IMPOSTOR_CUBE_FACES as TREE_IMPOSTOR_FACES } from "./Impostor";

function createTreeProvider(species: TreeSpecies) {
  const tree = TREE_SPECIES[species];
  return createImpostorAssetProvider({
    name: `${species}TreeImpostor`,
    queryPrefix: species === "birch" ? "tree-impostor" : `${species}-tree-impostor`,
    createSource: (scene) => tree.create(scene),
    sourceHeight: tree.sourceHeight,
    captureDiameter: tree.captureDiameter,
    boundsPadding: 1.04,
    preserveCaptureAspectRatio: true,
    minimumResolutionWidth: 64,
    faces: IMPOSTOR_CUBE_FACES,
    sampling: {
      horizontalSamples: { default: 5, minimum: 1, maximum: 16 },
      verticalSamples: { default: 5, minimum: 1, maximum: 10 },
      resolution: { default: 192, minimum: 64, maximum: 256 },
    },
  });
}

const treeImpostors = Object.fromEntries(
  TREE_SPECIES_LIST.map((species) => [species, createTreeProvider(species)]),
) as Record<TreeSpecies, ReturnType<typeof createTreeProvider>>;

/** Shares one tree atlas capture per scene and capture-attribute combination. */
export async function getTreeImpostorAssets(
  scene: Scene,
  horizontalSamples = treeImpostors.birch.getDefaultSampling().horizontalSamples,
  verticalSamples = treeImpostors.birch.getDefaultSampling().verticalSamples,
  resolution = treeImpostors.birch.getDefaultSampling().resolution,
  species: TreeSpecies = "birch",
): Promise<TreeImpostorAssets> {
  // The capture source is foliage geometry, so its cards need the leaf image's
  // proportions before this species is built and baked into an atlas.
  await measureFoliageTextures();
  return treeImpostors[species].getAssets(scene, {
    horizontalSamples,
    verticalSamples,
    resolution,
  });
}

/** Builds the original procedural geometry at the requested rendered height. */
export async function createTreeModels(
  scene: Scene,
  renderHeight: number,
  species: TreeSpecies = "birch",
): Promise<Mesh[]> {
  await measureFoliageTextures();
  const treeDefinition = TREE_SPECIES[species];
  const tree = treeDefinition.create(scene, {
    name: `${species}TreeModels`,
    liveLighting: true,
  });
  const positions = tree.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) throw new Error("Procedural tree has no position data.");

  const renderScale = renderHeight / treeDefinition.sourceHeight;
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
