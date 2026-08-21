import { ShaderMaterial, Vector2 } from "@babylonjs/core";

/**
 * One shared, looping wind cycle drives grass and bushes. Live geometry bends
 * in the vertex shader while impostors warp their lookup by the same shear.
 */

/** Seconds for one seamless wind loop. */
const LOOP_SECONDS = 3.6;
/** Distance between gust crests; instances a wavelength apart move alike. */
const GUST_WAVELENGTH_METERS = 34;
/** Travel direction of the gust front across the world's XZ plane. */
const GUST_DIRECTION = new Vector2(0.78, 0.63);
/**
 * Tip displacement as a fraction of height for vegetation that leans by a pure
 * shear. Grass bends further than woody bushes.
 */
const SHEAR_FRACTIONS = { grass: 0.19, bush: 0.075 } as const;

export type ShearedVegetation = keyof typeof SHEAR_FRACTIONS;

/** Uniforms every wind-aware shader needs to place itself in the loop. */
export const WIND_PHASE_UNIFORMS: readonly string[] = [
  "windPhase",
  "windGustFrequency",
  "windDirection",
];
/** Additional uniforms needed only by shaders that displace real geometry. */
export const WIND_SWAY_UNIFORMS: readonly string[] = [
  "windSwayFraction",
  "windModelBaseY",
  "windModelHeight",
];
/** Additional uniform for shaders that lean their subject by a shear. */
export const WIND_SHEAR_UNIFORMS: readonly string[] = ["windShearFraction"];

const strengthScale = queryStrengthScale();
const phaseOverrides = new WeakMap<ShaderMaterial, number>();
// Rebuilt only when the ground scale changes, because every wind-aware
// material reads it on every bind.
const gustFrequency = new Vector2();
/** Wind blows the way its gusts travel. */
const direction = GUST_DIRECTION.clone().normalize();
let metersPerUnit = 0;

/** Wind is spatially periodic in meters, so it needs the scene's ground scale. */
export function configureWindSceneScale(scenePerUnit: number): void {
  if (!Number.isFinite(scenePerUnit) || scenePerUnit <= 0) return;
  metersPerUnit = scenePerUnit;
  GUST_DIRECTION.normalizeToRef(gustFrequency);
  gustFrequency.scaleInPlace(metersPerUnit / GUST_WAVELENGTH_METERS);
}

// Materials can be created before any ground scale is known, so start from a
// usable one rather than a zero-frequency gust that never travels.
configureWindSceneScale(1);

/** Tip displacement as a fraction of height, honoring `?wind=`. */
export function windShearFraction(kind: ShearedVegetation): number {
  return SHEAR_FRACTIONS[kind] * strengthScale;
}

/**
 * Widens a capture so the swayed silhouette still fits inside the frame. The
 * two sway axes are a fifth of a loop apart, so their combined reach slightly
 * exceeds the primary amplitude.
 */
export function windSwayReach(modelHeight: number, swayFraction: number): number {
  return 1.1 * swayFraction * modelHeight;
}

/** Position within the current wind loop, wrapped to [0, 1). */
export function currentWindLoopPhase(): number {
  if (typeof performance === "undefined") return 0;
  const loops = performance.now() / 1000 / LOOP_SECONDS;
  return loops - Math.floor(loops);
}

/** Pins a material to one moment of the loop, as the capture pass needs. */
export function setWindPhaseOverride(material: ShaderMaterial, phase?: number): void {
  if (phase === undefined) phaseOverrides.delete(material);
  else phaseOverrides.set(material, phase);
}

/** Sets how far a subject's tip leans, as a fraction of its own height. */
export function setWindShear(material: ShaderMaterial, shearFraction: number): void {
  material.setFloat("windShearFraction", shearFraction);
}

/** Describes the sway of one model whose base sits at `baseY` in local space. */
export function setWindSway(
  material: ShaderMaterial,
  swayFraction: number,
  baseY: number,
  modelHeight: number,
): void {
  material.setFloat("windSwayFraction", swayFraction);
  material.setFloat("windModelBaseY", baseY);
  material.setFloat("windModelHeight", modelHeight);
}

/** Advances a material through the loop, unless it is pinned for capture. */
export function bindWindPhase(material: ShaderMaterial): void {
  const override = phaseOverrides.get(material);
  material.setFloat("windPhase", override ?? currentWindLoopPhase());
  material.setVector2("windGustFrequency", gustFrequency);
  material.setVector2("windDirection", direction);
}

/**
 * Locates an instance in the wind loop. Gusts travel across the world, so
 * instances a gust wavelength apart are a full loop out of phase and the
 * field reads as one moving air mass rather than a set of metronomes.
 */
export const windPhaseVertexDeclaration = `
uniform float windPhase;
uniform vec2 windGustFrequency;
uniform vec2 windDirection;

float windLoopPhase(vec3 instanceOrigin) {
  return windPhase + dot(instanceOrigin.xz, windGustFrequency);
}`;

/**
 * The displacement itself. Every vertex moves on the loop's fundamental
 * frequency and differs only in phase, which is what makes a handful of
 * captured moments enough: a pure sine is reconstructed from four samples,
 * while harmonics or per-vertex flutter would alias into noise between frames.
 */
export const windSwayVertexDeclaration = `
uniform float windSwayFraction;
uniform float windModelBaseY;
uniform float windModelHeight;

vec3 windSwayOffset(vec3 localPosition, float loopPhase, float foliage) {
  if (windSwayFraction <= 0.0) return vec3(0.0);
  // Base-relative and height-normalized, so a capture source and the scaled
  // live model built from it produce identical numbers here.
  vec3 normalized = (localPosition - vec3(0.0, windModelBaseY, 0.0))
    / max(windModelHeight, 0.0001);
  float height01 = clamp(normalized.y, 0.0, 1.0);
  // Height still softens the motion near the crown's attachment points.
  float flex = height01 * height01;
  // Leaves rustle in small neighboring groups while the woody structure stays
  // visually anchored. A trace response in wood avoids a perfectly rigid
  // silhouette without returning to a whole-tree crown swing.
  float cluster = dot(normalized, vec3(31.0, 17.0, 23.0));
  float leafVariation = 0.7 + 0.3 * sin(cluster);
  float materialResponse = mix(0.03, leafVariation, foliage);
  float lag = foliage * (0.3 + 0.18 * sin(cluster));
  float angle = 6.28318530718 * loopPhase - lag;
  return vec3(sin(angle), 0.0, sin(angle + 1.9) * 0.35)
    * (windSwayFraction * windModelHeight * flex * materialResponse);
}`;

/**
 * A pure shear leans a subject without moving its base, and needs no captured
 * moments at all: an impostor reproduces it by displacing the point it samples
 * within its own frame. That is what lets rotationally symmetric vegetation
 * sway, since a folded atlas cannot hold a directional pose. Nothing being
 * baked also frees the motion from what baking constrains — it can follow one
 * world direction and carry a harmonic, where the tree sway can do neither.
 */
export const windShearVertexDeclaration = `
uniform float windShearFraction;

/** Bend within the loop, in roughly [-1, 1]. */
float windBend(vec3 instanceOrigin) {
  float gust = windLoopPhase(instanceOrigin);
  // An integer harmonic keeps the ripple continuous when windPhase wraps from
  // one back to zero; a fractional multiplier creates a visible movement skip.
  float ripple = windPhase * 2.0 + dot(instanceOrigin.xz, windGustFrequency * 5.0);
  return sin(6.28318530718 * gust) * 0.74 + sin(6.28318530718 * ripple) * 0.26;
}

/** The world wind direction expressed in one instance's own local axes. */
vec2 windLocalDirection(vec3 axisX, vec3 axisZ) {
  vec3 world = vec3(windDirection.x, 0.0, windDirection.y);
  return vec2(dot(world, axisX), dot(world, axisZ));
}

/**
 * Displacement per unit of height above the base. Real geometry adds it; an
 * impostor subtracts it from the point it samples, which leans the captured
 * image by the same amount without touching the atlas.
 */
vec3 windShearGradient(vec2 localDirection, float bend) {
  return vec3(localDirection.x, 0.0, localDirection.y) * (windShearFraction * bend);
}

vec3 windShearOffset(vec3 localPosition, float baseY, vec2 localDirection, float bend) {
  if (windShearFraction <= 0.0) return vec3(0.0);
  // Deliberately unclamped: staying exactly linear is what makes the proxy
  // box's own interpolation reproduce the shear at every point inside it.
  return windShearGradient(localDirection, bend) * (localPosition.y - baseY);
}`;

function queryStrengthScale(): number {
  if (typeof window === "undefined") return 1;
  // `wind=0` is a meaningful request, so an absent parameter must be told
  // apart from a zero one rather than coerced through Number(null).
  const raw = new URLSearchParams(window.location.search).get("wind");
  if (raw === null) return 1;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 3 ? value : 1;
}
