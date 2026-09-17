import {
  Color3,
  Material,
  Mesh,
  RawTexture,
  Scene,
  StandardMaterial,
  Texture,
} from "@babylonjs/core";
import {
  createTerrainTextureData,
  TERRAIN_ALBEDO_LAYER,
  TERRAIN_DETAIL_LAYER,
  TERRAIN_NORMAL_LAYER,
} from "./TerrainTextureData";
import type { TerrainTextureData, TerrainTextureLayer } from "./TerrainTextureData";
import { createCloudShadowTerrainMaterial } from "../sky/CloudShadows";
import { TerrainReliefNormalsPlugin } from "./TerrainReliefNormals";
import { SnowCoverPlugin } from "../rendering/SnowCover";

let cachedTextureData: TerrainTextureData | undefined;
const sceneMaterials = new WeakMap<Scene, {
  tinted: StandardMaterial;
  untinted: StandardMaterial;
}>();
const sharedMaterials = new WeakSet<Material>();

/**
 * Pushes terrain a tiny distance back in the depth buffer. Vegetation keeps
 * its real depth, so it wins against the ground without drawing over objects
 * that genuinely stand in front of it.
 */
export function applyTerrainDepthBias(material: Material): void {
  material.zOffset = 1;
  material.zOffsetUnits = 1;
}

export interface TerrainMaterialOptions {
  /**
   * Land-cover vertex colors tint the surface, so the textures stay neutral and
   * only carry relief and grain.
   */
  usesLandCoverTint?: boolean;
}

/**
 * Returns the scene-owned terrain material. Terrain UVs are expressed in
 * metres, so every tile can share both the materials and their GPU textures.
 */
export function createTerrainMaterial(
  scene: Scene,
  options: TerrainMaterialOptions = {},
): StandardMaterial {
  const cached = sceneMaterials.get(scene);
  if (cached) {
    return options.usesLandCoverTint ? cached.tinted : cached.untinted;
  }

  cachedTextureData ??= createTerrainTextureData();
  const textures = cachedTextureData;

  const albedo = createTiledTexture(
    textures.albedo,
    TERRAIN_ALBEDO_LAYER,
    "terrainAlbedo",
    scene,
  );

  const normal = createTiledTexture(
    textures.normal,
    TERRAIN_NORMAL_LAYER,
    "terrainNormal",
    scene,
  );
  normal.level = 0.78;

  const detail = createTiledTexture(
    textures.detail,
    TERRAIN_DETAIL_LAYER,
    "terrainDetail",
    scene,
  );

  const createMaterial = (usesLandCoverTint: boolean): StandardMaterial => {
    const name = usesLandCoverTint
      ? "terrainMaterialTinted"
      : "terrainMaterialUntinted";
    const material = createCloudShadowTerrainMaterial(name, scene)
      ?? new StandardMaterial(name, scene);
    material.diffuseTexture = albedo;
    new TerrainReliefNormalsPlugin(material);
    material.bumpTexture = normal;
    // One extra sampler buys both the finest grain and its micro-relief: Babylon
    // reads red as albedo modulation around 0.5 and alpha/green as normal xy.
    material.detailMap.texture = detail;
    material.detailMap.diffuseBlendLevel = 0.85;
    material.detailMap.bumpLevel = 0.9;
    material.detailMap.isEnabled = true;
    material.diffuseColor = usesLandCoverTint
      ? Color3.White()
      : new Color3(0.7, 0.62, 0.5);
    material.specularColor = new Color3(0.035, 0.04, 0.03);
    material.specularPower = 24;
    // Snow depth is a per-tile mesh property read at bind time, so both shared
    // materials carry the same plugin and no separate winter material exists.
    // The ground itself rises by the settled depth; everything standing on it
    // sinks into the snow by the same amount.
    new SnowCoverPlugin(material, { displace: true });
    applyTerrainDepthBias(material);
    sharedMaterials.add(material);
    return material;
  };

  const materials = {
    tinted: createMaterial(true),
    untinted: createMaterial(false),
  };
  sceneMaterials.set(scene, materials);
  return options.usesLandCoverTint ? materials.tinted : materials.untinted;
}

/** Shared terrain materials are disposed with their scene, not with one tile. */
export function isSharedTerrainMaterial(material: Material | null): boolean {
  return material !== null && sharedMaterials.has(material);
}

/** Releases a terrain mesh without destroying scene-owned materials or textures. */
export function disposeTerrainMesh(terrain: Mesh): void {
  const material = terrain.material;
  terrain.material = null;
  if (material && !isSharedTerrainMaterial(material)) material.dispose(true, true);
  terrain.dispose(false, false);
}

function createTiledTexture(
  data: Uint8Array,
  layer: TerrainTextureLayer,
  name: string,
  scene: Scene,
): Texture {
  const texture = RawTexture.CreateRGBATexture(
    data,
    layer.size,
    layer.size,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  texture.name = name;
  // Raw channel values; nothing here is a color to be linearized.
  texture.gammaSpace = false;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.uScale = 1 / layer.metersPerRepeat;
  texture.vScale = 1 / layer.metersPerRepeat;
  // Ground is nearly always seen at a grazing angle, where trilinear filtering
  // alone collapses these layers into mush a few metres ahead of the camera.
  texture.anisotropicFilteringLevel = 16;
  return texture;
}
