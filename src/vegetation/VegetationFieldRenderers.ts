import { Mesh, Scene, TransformNode } from "@babylonjs/core";
import type { ImpostorAssetLease, ImpostorAssets } from "../rendering/Impostor";
import { createImpostorPrototypeFromAssets, type ImpostorDepthOptions } from "./TreeField";
import { combineVegetationFieldResults, createVegetationFieldResult, type VegetationFieldResult } from "./VegetationField";
import { packInstanceMatrices, proceduralBucketSuffix, type ProceduralPlacementBucket, type VegetationPlacementOptions } from "./VegetationPlacement";

interface VegetationFieldRendererOptions {
  rootName: string;
  impostorName: string;
  renderHeight: number;
  startDisabled?: boolean;
  depth?: ImpostorDepthOptions;
  loadAssets: () => Promise<ImpostorAssets | ImpostorAssetLease>;
  createModel: () => Mesh | Promise<Mesh>;
}

export interface VegetationFieldRenderers {
  root: TransformNode;
  impostor: Mesh;
  model: Mesh;
  captureSize: number;
}

/** Assembles regional renderers while retaining the field's original placement order. */
export async function createRegionalVegetationField(
  scene: Scene,
  root: TransformNode,
  buckets: Iterable<ProceduralPlacementBucket>,
  instanceMatrices: Float32Array,
  { metersPerUnit, renderMode = "auto", yieldControl }: Pick<VegetationPlacementOptions, "metersPerUnit" | "renderMode" | "yieldControl">,
  describe: (bucket: ProceduralPlacementBucket, suffix: string) => VegetationFieldRendererOptions & {
    configure: (impostor: Mesh, model: Mesh) => void;
  },
): Promise<VegetationFieldResult> {
  const fields: VegetationFieldResult[] = [];
  for (const bucket of buckets) {
    const options = describe(bucket, proceduralBucketSuffix(bucket));
    const renderers = await createVegetationFieldRenderers(scene, options);
    renderers.root.parent = root;
    options.configure(renderers.impostor, renderers.model);
    fields.push(await createVegetationFieldResult(
      renderers.root, [renderers.impostor], [renderers.model],
      await packInstanceMatrices(bucket.matrices, yieldControl),
      metersPerUnit, renderMode,
      bucket.colors.length ? new Float32Array(bucket.colors) : undefined,
      yieldControl,
    ));
  }
  return combineVegetationFieldResults(root, fields, instanceMatrices);
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
    const model = await options.createModel();
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
