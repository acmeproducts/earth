import { MaterialPluginBase } from "@babylonjs/core";
import type {
  AbstractEngine, AbstractMesh, Material, MaterialDefines, Scene, SubMesh, TransformNode, UniformBuffer,
} from "@babylonjs/core";
import { SEA_LEVEL_METERS } from "../world/Geo";

/**
 * Snow cover shared by every procedural surface. One GLSL snippet decides how
 * much snow hides a fragment from its world-up cosine, a local drift pattern
 * and the tile's snow depth, and how deep the settled layer is on level
 * ground. Babylon materials (terrain, rocks, buildings, roads, lamps) receive
 * it through `SnowCoverPlugin` with a per-mesh depth; the vegetation shader
 * inlines the same functions so live models and the atlases captured from
 * them agree. Geometry with thickness is added separately by SnowShell and
 * SnowFall.
 */
export const snowCoverFragmentFunctions = `
float snowHash2(vec2 point) {
  return fract(sin(dot(floor(point), vec2(127.1, 311.7))) * 43758.5453);
}
float snowNoise2(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  local = local * local * (3.0 - 2.0 * local);
  return mix(
    mix(snowHash2(cell), snowHash2(cell + vec2(1.0, 0.0)), local.x),
    mix(snowHash2(cell + vec2(0.0, 1.0)), snowHash2(cell + vec2(1.0, 1.0)), local.x),
    local.y
  );
}
// Depth variation in [0, 1]: banks a few metres across with finer ripples.
float snowDrift(vec2 worldMeters) {
  return snowNoise2(worldMeters / 7.0) * 0.6
    + snowNoise2(worldMeters / 1.7 + vec2(3.1, 8.7)) * 0.4;
}
// Settled depth on level ground in metres: the broad banks only, so coarse
// far tessellations and fine near ones lift the same surface.
float snowDepthMeters(vec2 worldMeters, float amount) {
  return amount * (0.35 + 0.85 * amount) * (0.55 + 0.9 * snowNoise2(worldMeters / 7.0));
}
// Fraction of a surface hidden under snow. Steep faces shed it, drifts pile
// it, and a thin cover leaves the low spots bare.
float snowCoverage(float up, float drift, float amount) {
  float depth = amount * (0.5 + drift);
  float settled = smoothstep(0.12, 0.7, up);
  return smoothstep(0.02, 0.4, depth * settled - 0.04);
}
vec3 snowAlbedo(float drift) {
  return vec3(0.9, 0.94, 0.98) * (0.94 + 0.08 * drift);
}
`;

/** Specular sheen added to snow on Babylon-lit surfaces. */
const SNOW_SPECULAR = "vec3(0.14, 0.15, 0.17)";

/**
 * Optional per-vertex float attribute: 0 keeps a vertex bare and unlifted
 * (the ground under a building), 1 takes full snow. Absent means 1.
 */
export const SNOW_MASK_KIND = "snowMask";

interface MeshSnowCover {
  amount: number;
  metersPerUnit: number;
}

const meshSnowCovers = new WeakMap<AbstractMesh, MeshSnowCover>();

/** Sets how deep the snow lies on one mesh, in the shared [0, 1] scale. */
export function setMeshSnowCover(mesh: AbstractMesh, amount: number, metersPerUnit: number): void {
  if (amount > 0) meshSnowCovers.set(mesh, { amount, metersPerUnit });
  else meshSnowCovers.delete(mesh);
}

/** Snow depth previously set on a mesh, zero when bare. */
export function meshSnowCover(mesh: AbstractMesh): number {
  return meshSnowCovers.get(mesh)?.amount ?? 0;
}

/** Applies one snow depth to every mesh under a streamed layer root. */
export function setHierarchySnowCover(root: TransformNode, amount: number, metersPerUnit: number): void {
  if (root.isDisposed()) return;
  for (const mesh of root.getChildMeshes(false)) setMeshSnowCover(mesh, amount, metersPerUnit);
}

export interface SnowCoverPluginOptions {
  /**
   * Lifts vertices by the settled depth so the surface itself gains
   * thickness. For the ground and whatever lies flush on it (roads); objects
   * standing on the ground keep their place and sink into the raised snow.
   */
  displace?: boolean;
  /** Hide stone bump detail beneath settled snow. */
  smoothSurface?: boolean;
}

interface SnowDefines extends MaterialDefines {
  SNOW_COVER: boolean;
  SNOW_DISPLACE: boolean;
  SNOW_MASK: boolean;
}

/**
 * Adds snow to a StandardMaterial-based surface. The depth is read per mesh
 * at bind time, so scene-shared materials (terrain) and frozen materials
 * (rocks) both work without shader variants or unfreezing.
 */
export class SnowCoverPlugin extends MaterialPluginBase {
  private readonly displace: boolean;
  private readonly smoothSurface: boolean;

  constructor(material: Material, options: SnowCoverPluginOptions = {}) {
    super(material, "SnowCover", 190, {
      SNOW_COVER: true, SNOW_DISPLACE: Boolean(options.displace), SNOW_MASK: false,
    });
    this.displace = Boolean(options.displace);
    this.smoothSurface = Boolean(options.smoothSurface);
    // hardBindForSubMesh is only dispatched to plugins registered for extra events.
    this.registerForExtraEvents = true;
    this._enable(true);
  }

  getClassName(): string { return "SnowCoverPlugin"; }

  prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    const snowDefines = defines as SnowDefines;
    snowDefines.SNOW_COVER = true;
    snowDefines.SNOW_DISPLACE = this.displace;
    snowDefines.SNOW_MASK = mesh.isVerticesDataPresent(SNOW_MASK_KIND);
  }

  getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh): void {
    if (mesh.isVerticesDataPresent(SNOW_MASK_KIND)) attributes.push(SNOW_MASK_KIND);
  }

  getUniforms() {
    const declaration = "#ifdef SNOW_COVER\nuniform vec4 snowCoverParams;\n#endif";
    return {
      ubo: [{ name: "snowCoverParams", size: 4, type: "vec4" }],
      vertex: declaration,
      fragment: declaration,
    };
  }

  hardBindForSubMesh(buffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const cover = meshSnowCovers.get(subMesh.getMesh());
    const metersPerUnit = cover?.metersPerUnit ?? 1;
    buffer.updateFloat4(
      "snowCoverParams",
      cover?.amount ?? 0,
      metersPerUnit,
      SEA_LEVEL_METERS / metersPerUnit,
      0,
    );
  }

  getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `
#ifdef SNOW_COVER
${snowCoverFragmentFunctions}
varying float vSnowDrift;
varying float vSnowMask;
#ifdef SNOW_MASK
attribute float snowMask;
#endif
#endif`,
        // Runs before the world transform is applied; the ground never uses
        // instancing, so the plain world matrix gives the world position.
        CUSTOM_VERTEX_UPDATE_POSITION: `
#if defined(SNOW_DISPLACE) && !defined(INSTANCES)
if (snowCoverParams.x > 0.0) {
  vec3 snowWorld = (world * vec4(positionUpdated, 1.0)).xyz;
  float snowShore = smoothstep(snowCoverParams.z, snowCoverParams.z + 0.6 / snowCoverParams.y, snowWorld.y);
  #ifdef SNOW_MASK
  snowShore *= snowMask;
  #endif
  positionUpdated.y += snowDepthMeters(snowWorld.xz * snowCoverParams.y, snowCoverParams.x)
    * snowShore / snowCoverParams.y;
}
#endif`,
        // The drift pattern is vertex detail: interpolating it saves two noise
        // evaluations on every ground pixel.
        CUSTOM_VERTEX_UPDATE_WORLDPOS: `
#ifdef SNOW_COVER
vSnowDrift = snowDrift(worldPos.xz * snowCoverParams.y);
#ifdef SNOW_MASK
vSnowMask = snowMask;
#else
vSnowMask = 1.0;
#endif
#endif`,
      };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef SNOW_COVER
${snowCoverFragmentFunctions}
varying float vSnowDrift;
varying float vSnowMask;
#endif`,
      CUSTOM_FRAGMENT_MAIN_BEGIN: `
#ifdef SNOW_COVER
float snowCoverValue = 0.0;
#endif`,
      // Runs after the material's own diffuse hooks (vertex tint, facade
      // patterns, road texture) so the snow lies on top of the finished surface.
      // Snow melts away at the water line and stays off masked ground.
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
#ifdef SNOW_COVER
if (snowCoverParams.x > 0.0) {
  float snowDriftValue = vSnowDrift;
  float snowShore = smoothstep(snowCoverParams.z, snowCoverParams.z + 0.6 / snowCoverParams.y, vPositionW.y);
  vec3 snowNormal = normalW;
  ${this.smoothSurface ? `
  #ifdef NORMAL
  snowNormal = normalize(vNormalW);
  #ifdef TWOSIDEDLIGHTING
  snowNormal = gl_FrontFacing ? snowNormal : -snowNormal;
  #endif
  #endif
  ` : ""}
  snowCoverValue = snowCoverage(snowNormal.y, snowDriftValue, snowCoverParams.x) * snowShore * vSnowMask;
  // Settled snow hides the underlying material's bump and detail normals.
  normalW = normalize(mix(normalW, snowNormal, snowCoverValue));
  baseColor.rgb = mix(baseColor.rgb, snowAlbedo(snowDriftValue), snowCoverValue);
  diffuseColor = mix(diffuseColor, vec3(1.0), snowCoverValue);
}
#endif`,
      CUSTOM_FRAGMENT_BEFORE_FOG: `
#if defined(SNOW_COVER) && defined(SPECULARTERM)
color.rgb += specularBase * ${SNOW_SPECULAR} * snowCoverValue;
#endif`,
    };
  }
}
