import {
  MaterialPluginBase, RawTexture, Texture,
} from "@babylonjs/core";
import type {
  AbstractEngine, AbstractMesh, Material, MaterialDefines, Scene, SubMesh, UniformBuffer,
} from "@babylonjs/core";
import type { TerrainData } from "./TerrainData";
import { TerrainNormalEdges } from "./TerrainNormalEdges";

const maps = new WeakMap<AbstractMesh, { texture: RawTexture; width: number; depth: number; metersPerUnit: number }>();
const sceneNormalEdges = new WeakMap<Scene, TerrainNormalEdges>();

// Boundary skirts use the parent's local coordinates and must shade like its surface.
function reliefMap(mesh: AbstractMesh) {
  return maps.get(mesh) ?? (mesh.parent ? maps.get(mesh.parent as AbstractMesh) : undefined);
}

// Soften fine raster ridges against a common physical-scale slope, never against
// mesh normals: those differ between near and far tessellations.
const TERRAIN_RELIEF_NORMAL_STRENGTH = 0.25;
const TERRAIN_NORMAL_BASELINE_METERS = 12;

/** World-space normals from the elevation raster, independent of mesh tessellation. */
export function terrainReliefNormalPixels(terrain: TerrainData): Uint8Array {
  const { width, height, elevations, shadingRelief, reliefReferenceElevations } = terrain;
  const pixels = new Uint8Array(width * height * 4);
  const dx = terrain.groundWidthMeters / Math.max(1, width - 1);
  const dz = terrain.groundHeightMeters / Math.max(1, height - 1);
  const baselineX = Math.max(1, Math.round(TERRAIN_NORMAL_BASELINE_METERS / dx));
  const baselineZ = Math.max(1, Math.round(TERRAIN_NORMAL_BASELINE_METERS / dz));
  const elevation = (x: number, y: number): number => {
    const index = y * width + x;
    // Carved water, roads and building pads must not regain the removed bumps.
    const change = Math.abs(elevations[index] - (reliefReferenceElevations?.[index] ?? elevations[index]));
    const retained = Math.max(0, 1 - change / 0.25);
    return elevations[index] + (shadingRelief?.[index] ?? 0) * retained;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - 1), right = Math.min(width - 1, x + 1);
      const north = Math.max(0, y - 1), south = Math.min(height - 1, y + 1);
      const fineX = -(elevation(right, y) - elevation(left, y)) / Math.max(dx, (right - left) * dx);
      // Raster rows run south, opposite to positive scene Z.
      const fineZ = (elevation(x, south) - elevation(x, north)) / Math.max(dz, (south - north) * dz);
      const westBase = Math.max(0, x - baselineX), eastBase = Math.min(width - 1, x + baselineX);
      const northBase = Math.max(0, y - baselineZ), southBase = Math.min(height - 1, y + baselineZ);
      const broadX = -(elevation(eastBase, y) - elevation(westBase, y)) /
        Math.max(dx, (eastBase - westBase) * dx);
      const broadZ = (elevation(x, southBase) - elevation(x, northBase)) /
        Math.max(dz, (southBase - northBase) * dz);
      const nx = broadX + (fineX - broadX) * TERRAIN_RELIEF_NORMAL_STRENGTH;
      const nz = broadZ + (fineZ - broadZ) * TERRAIN_RELIEF_NORMAL_STRENGTH;
      const length = Math.hypot(nx, 1, nz);
      const index = (y * width + x) * 4;
      pixels[index] = Math.round((nx / length * 0.5 + 0.5) * 255);
      pixels[index + 1] = Math.round((1 / length * 0.5 + 0.5) * 255);
      pixels[index + 2] = Math.round((nz / length * 0.5 + 0.5) * 255);
      const sampleIndex = y * width + x;
      // Grading changes the shape of sand, not its material. Suppressing this
      // mask with deformation exposed soil-colored halos around roads and pads.
      pixels[index + 3] = Math.round(255 * Math.min(1, (terrain.sandCoverage?.[sampleIndex] ?? 0) * 2));
    }
  }
  return pixels;
}

export function attachTerrainReliefNormals(
  mesh: AbstractMesh, terrain: TerrainData, width: number, depth: number,
  metersPerUnit = terrain.groundWidthMeters / width,
): void {
  const pixels = terrainReliefNormalPixels(terrain);
  const texture = RawTexture.CreateRGBATexture(
    pixels, terrain.width, terrain.height,
    mesh.getScene(), true, false, Texture.TRILINEAR_SAMPLINGMODE,
  );
  texture.name = `${mesh.name} relief normals`;
  texture.gammaSpace = false;
  texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 16;
  maps.set(mesh, { texture, width, depth, metersPerUnit });
  const scene = mesh.getScene();
  let edges = sceneNormalEdges.get(scene);
  if (!edges) { edges = new TerrainNormalEdges(); sceneNormalEdges.set(scene, edges); }
  const remove = terrain.worldTile && edges.add(terrain.worldTile, terrain.width, terrain.height,
    pixels, () => texture.update(pixels));
  mesh.onDisposeObservable.addOnce(() => { remove?.(); texture.dispose(); maps.delete(mesh); });
}

/** Per-mesh maps with scene-shared materials; rebind even on consecutive tiles. */
export class TerrainReliefNormalsPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "TerrainReliefNormals", 180, { TERRAIN_RELIEF_NORMALS: false });
    this.registerForExtraEvents = true;
    this._enable(true);
  }

  prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    (defines as MaterialDefines & { TERRAIN_RELIEF_NORMALS: boolean }).TERRAIN_RELIEF_NORMALS = Boolean(reliefMap(mesh));
  }

  getSamplers(samplers: string[]): void { samplers.push("terrainReliefNormals"); }

  getUniforms() {
    return {
      ubo: [{ name: "terrainReliefUV", size: 4, type: "vec4" },
        { name: "terrainSandScale", size: 1, type: "float" }],
      fragment: "#ifdef TERRAIN_RELIEF_NORMALS\nuniform vec4 terrainReliefUV;\nuniform float terrainSandScale;\n#endif",
    };
  }

  hardBindForSubMesh(buffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const map = reliefMap(subMesh.getMesh());
    if (!map) return;
    const size = map.texture.getSize();
    buffer.updateFloat4("terrainReliefUV",
      (size.width - 1) / size.width / map.width,
      -(size.height - 1) / size.height / map.depth, 0.5, 0.5);
    buffer.setTexture("terrainReliefNormals", map.texture);
    buffer.updateFloat("terrainSandScale", map.metersPerUnit);
  }

  getCustomCode(shaderType: string): Record<string, string> {
    if (shaderType === "vertex") return {
      CUSTOM_VERTEX_DEFINITIONS: "#ifdef TERRAIN_RELIEF_NORMALS\nvarying vec2 vTerrainReliefXZ;\n#endif",
      CUSTOM_VERTEX_MAIN_END: "#ifdef TERRAIN_RELIEF_NORMALS\nvTerrainReliefXZ = positionUpdated.xz;\n#endif",
    };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef TERRAIN_RELIEF_NORMALS
varying vec2 vTerrainReliefXZ;
uniform sampler2D terrainReliefNormals;
float sandHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float sandNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sandHash(cell), sandHash(cell + vec2(1.0, 0.0)), f.x),
    mix(sandHash(cell + vec2(0.0, 1.0)), sandHash(cell + vec2(1.0)), f.x), f.y);
}
#endif`,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
#ifdef TERRAIN_RELIEF_NORMALS
float sandTintMask = texture2D(terrainReliefNormals,
  vTerrainReliefXZ * terrainReliefUV.xy + terrainReliefUV.zw).a;
vec2 sandTintPosition = vPositionW.xz * terrainSandScale;
float sandTone = 0.96 + 0.05 * sandNoise(sandTintPosition * 0.035) +
  0.015 * sandNoise(sandTintPosition * 1.7);
baseColor.rgb = mix(baseColor.rgb, vec3(0.84, 0.74, 0.52) * sandTone, sandTintMask);
#endif`,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
#ifdef TERRAIN_RELIEF_NORMALS
vec4 reliefSample = texture2D(terrainReliefNormals,
  vTerrainReliefXZ * terrainReliefUV.xy + terrainReliefUV.zw);
vec3 reliefNormal = normalize(reliefSample.rgb * 2.0 - 1.0);
// Both LODs use the softened raster slope. Keep only the fine bump contribution
// from the material, with no residual weighting of the mesh's base normal.
normalW = normalize(reliefNormal + normalW - normalize(vNormalW));
vec2 sandPosition = vPositionW.xz * terrainSandScale;
vec2 windPosition = vec2(dot(sandPosition, vec2(0.84, 0.54)),
  dot(sandPosition, vec2(-0.54, 0.84)));
float rippleWarp = 6.0 * sandNoise(windPosition * vec2(0.35, 0.9)) +
  1.8 * sandNoise(windPosition * vec2(1.2, 2.5) + vec2(37.0, 19.0));
float ripplePhase = windPosition.x * 25.1327 + rippleWarp;
float rippleFade = 1.0 - smoothstep(0.8, 2.5, fwidth(ripplePhase));
float sandAmount = reliefSample.a;
float rippleStrength = mix(0.015, 0.075, smoothstep(0.25, 0.75, sandNoise(windPosition * 0.3)));
normalW = normalize(mix(normalW, reliefNormal, sandAmount) +
  vec3(0.84, 0.0, 0.54) * cos(ripplePhase) * rippleStrength * sandAmount * rippleFade);
#endif`,
    };
  }
}
