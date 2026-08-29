import { ShaderMaterial, Vector2 } from "@babylonjs/core";
import { SimplexNoise2D } from "./SimplexNoise";

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
const SHEAR_FRACTIONS = { grass: 0.19, bush: 0.075, tree: 0.015 } as const;
const WIND_NOISE = new SimplexNoise2D(0x51a7);
const WIND_NOISE_RATE = 0.018;
const WIND_BASE_STRENGTH = 0.68;
const WIND_GUST_STRENGTH = 0.52;
const WIND_BASE_SPEED = 20;

export type ShearedVegetation = keyof typeof SHEAR_FRACTIONS;

/** Uniforms every wind-aware shader needs to place itself in the loop. */
export const WIND_PHASE_UNIFORMS: readonly string[] = [
  "windPhase",
  "windGustFrequency",
  "windDirection",
  "windStrength",
];
/** Additional uniform for shaders that lean their subject by a shear. */
export const WIND_SHEAR_UNIFORMS: readonly string[] = ["windShearFraction"];

const strengthScale = queryStrengthScale();
// Stores the spatial frequency scale for the current ground scale. Every
// wind-aware material reads the sampled direction on bind.
const gustFrequency = new Vector2();
const sampledGustFrequency = new Vector2();
/** Wind blows the way its gusts travel. */
const direction = GUST_DIRECTION.clone().normalize();
let metersPerUnit = 0;
let manualSpeedMetersPerSecond: number | undefined;

export interface WindState {
  readonly direction: Vector2;
  /** Dimensionless gust strength. One is the nominal wind. */
  readonly strength: number;
  /** Prevailing speed in meters per second before scene scaling. */
  readonly speedMetersPerSecond: number;
}

/** Samples the shared, smoothly varying weather wind layer. */
export function currentWindState(
  nowMilliseconds = typeof performance === "undefined" ? 0 : performance.now(),
): WindState {
  const seconds = Math.max(0, nowMilliseconds) / 1_000;
  const time = seconds * WIND_NOISE_RATE;
  const gust = WIND_NOISE.sample(time, 11.7);
  const crosswind = WIND_NOISE.sample(time * 0.61, 37.2) * 0.16;
  const windDirection = new Vector2(
    direction.x - direction.y * crosswind,
    direction.y + direction.x * crosswind,
  ).normalize();
  const strength = Math.max(0, (WIND_BASE_STRENGTH + gust * WIND_GUST_STRENGTH) * strengthScale);
  const speedMetersPerSecond = manualSpeedMetersPerSecond ?? WIND_BASE_SPEED * strength;
  return {
    direction: windDirection,
    strength: manualSpeedMetersPerSecond === undefined
      ? strength
      : Math.max(0, Math.min(3, speedMetersPerSecond / WIND_BASE_SPEED)),
    speedMetersPerSecond,
  };
}

/** Sets the artist/debug weather override used by all wind-aware systems. */
export function setManualWindSpeed(speedMetersPerSecond: number | undefined): void {
  manualSpeedMetersPerSecond = speedMetersPerSecond === undefined
    ? undefined
    : Math.max(0, Math.min(30, speedMetersPerSecond));
}

/** Copies the normalized prevailing wind direction on the world's XZ plane. */
export function copyPrevailingWindDirectionTo(result: Vector2): void {
  result.copyFrom(direction);
}

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

/** Position within the current wind loop, wrapped to [0, 1). */
export function currentWindLoopPhase(): number {
  if (typeof performance === "undefined") return 0;
  const loops = performance.now() / 1000 / LOOP_SECONDS;
  return loops - Math.floor(loops);
}

/** Sets how far a subject's tip leans, as a fraction of its own height. */
export function setWindShear(material: ShaderMaterial, shearFraction: number): void {
  material.setFloat("windShearFraction", shearFraction);
}

/** Advances a material through the shared wind loop. */
export function bindWindPhase(material: ShaderMaterial): void {
  const state = currentWindState();
  sampledGustFrequency.copyFrom(state.direction).scaleInPlace(gustFrequency.length());
  material.setFloat("windPhase", currentWindLoopPhase());
  material.setVector2("windGustFrequency", sampledGustFrequency);
  material.setVector2("windDirection", state.direction);
  material.setFloat("windStrength", state.strength);
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
uniform float windStrength;

float windLoopPhase(vec3 instanceOrigin) {
  return windPhase + dot(instanceOrigin.xz, windGustFrequency);
}`;

/**
 * A pure shear leans a subject without moving its base, and needs no captured
 * moments at all: an impostor reproduces it by displacing the point it samples
 * within its own frame. That is what lets rotationally symmetric vegetation
 * sway, since a folded atlas cannot hold a directional pose. Nothing being
 * baked also frees the motion from what baking constrains — it can follow one
 * world direction and carry a harmonic.
 */
export const windShearVertexDeclaration = `
uniform float windShearFraction;

/** Bend within the loop, in roughly [-1, 1]. */
float windBend(vec3 instanceOrigin) {
  float gust = windLoopPhase(instanceOrigin);
  // An integer harmonic keeps the ripple continuous when windPhase wraps from
  // one back to zero; a fractional multiplier creates a visible movement skip.
  float ripple = windPhase * 2.0 + dot(instanceOrigin.xz, windGustFrequency * 5.0);
  return (sin(6.28318530718 * gust) * 0.74 + sin(6.28318530718 * ripple) * 0.26) * windStrength;
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
