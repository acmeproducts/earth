import { Mesh, Scene, TransformNode } from "@babylonjs/core";
import type { ImpostorAssetLease, ImpostorAssets } from "./Impostor";
import { createImpostorPrototypeFromAssets, type ImpostorDepthOptions } from "./TreeField";

interface VegetationFieldRendererOptions {
  rootName: string;
  impostorName: string;
  renderHeight: number;
  startDisabled?: boolean;
  depth?: ImpostorDepthOptions;
  loadAssets: () => Promise<ImpostorAssets | ImpostorAssetLease>;
  createModel: () => Mesh;
}

export interface VegetationFieldRenderers {
  root: TransformNode;
  impostor: Mesh;
  model: Mesh;
  captureSize: number;
}

/** Creates and owns the model/impostor pair shared by low vegetation fields. */
export async function createVegetationFieldRenderers(
  scene: Scene,
  options: VegetationFieldRendererOptions,
): Promise<VegetationFieldRenderers> {
  const root = new TransformNode(options.rootName, scene);
  if (options.startDisabled) root.setEnabled(false);
  let lease: ImpostorAssetLease | undefined;
  try {
    const loaded = await options.loadAssets();
    lease = "assets" in loaded ? loaded : undefined;
    const assets = lease ? lease.assets : loaded as ImpostorAssets;
    const prototype = createImpostorPrototypeFromAssets(
      scene,
      assets,
      options.renderHeight,
      root,
      options.impostorName,
      options.depth,
    );
    const model = options.createModel();
    model.parent = root;
    model.isPickable = false;

    // Do not force-dispose textures: vegetation materials bind the scene-owned
    // shadow map, which must survive individual streamed fields.
    root.onDisposeObservable.addOnce(() => model.material?.dispose(true, false));
    if (lease) root.onDisposeObservable.addOnce(() => lease?.release());
    return { root, impostor: prototype.mesh, model, captureSize: prototype.captureSize };
  } catch (error) {
    lease?.release();
    root.dispose(false, false);
    throw error;
  }
}
