import {
  Color3,
  Material,
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
  TerrainTextureData,
  TerrainTextureLayer,
} from "./TerrainTextureData";

/** Ground extent assumed when a caller cannot describe its own footprint. */
const FALLBACK_UV_EXTENT_METERS = 1200;

let cachedTextureData: TerrainTextureData | undefined;

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
  /**
   * Ground distance spanned by one full UV repeat of the mesh. Tiling is derived
   * from this so each layer lands at its intended real-world size no matter how
   * large an area the mesh covers.
   */
  uvWidthMeters?: number;
  uvHeightMeters?: number;
}

/** Owns the normal terrain appearance; debug layers are applied elsewhere. */
export function createTerrainMaterial(
  scene: Scene,
  options: TerrainMaterialOptions = {},
): StandardMaterial {
  const uvWidthMeters = options.uvWidthMeters ?? FALLBACK_UV_EXTENT_METERS;
  const uvHeightMeters = options.uvHeightMeters ?? uvWidthMeters;
  cachedTextureData ??= createTerrainTextureData();
  const textures = cachedTextureData;

  const albedo = createTiledTexture(
    textures.albedo,
    TERRAIN_ALBEDO_LAYER,
    "terrainAlbedo",
    scene,
    uvWidthMeters,
    uvHeightMeters,
  );

  const normal = createTiledTexture(
    textures.normal,
    TERRAIN_NORMAL_LAYER,
    "terrainNormal",
    scene,
    uvWidthMeters,
    uvHeightMeters,
  );
  normal.level = 0.78;

  const detail = createTiledTexture(
    textures.detail,
    TERRAIN_DETAIL_LAYER,
    "terrainDetail",
    scene,
    uvWidthMeters,
    uvHeightMeters,
  );

  const material = new StandardMaterial("terrainMaterial", scene);
  material.diffuseTexture = albedo;
  material.bumpTexture = normal;
  // One extra sampler buys both the finest grain and its micro-relief: Babylon
  // reads red as albedo modulation around 0.5 and alpha/green as normal xy.
  material.detailMap.texture = detail;
  material.detailMap.diffuseBlendLevel = 0.85;
  material.detailMap.bumpLevel = 0.9;
  material.detailMap.isEnabled = true;
  material.diffuseColor = options.usesLandCoverTint
    ? Color3.White()
    : new Color3(0.7, 0.62, 0.5);
  material.specularColor = new Color3(0.035, 0.04, 0.03);
  material.specularPower = 24;
  applyTerrainDepthBias(material);
  return material;
}

function createTiledTexture(
  data: Uint8Array,
  layer: TerrainTextureLayer,
  name: string,
  scene: Scene,
  uvWidthMeters: number,
  uvHeightMeters: number,
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
  texture.uScale = uvWidthMeters / layer.metersPerRepeat;
  texture.vScale = uvHeightMeters / layer.metersPerRepeat;
  // Ground is nearly always seen at a grazing angle, where trilinear filtering
  // alone collapses these layers into mush a few metres ahead of the camera.
  texture.anisotropicFilteringLevel = 16;
  return texture;
}
