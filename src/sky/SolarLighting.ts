import {
  Color3,
  DirectionalLight,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  ReflectionProbe,
  RenderTargetTexture,
  Scene,
  ShaderMaterial,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { SkyMaterial } from "@babylonjs/materials";
import * as SunCalc from "suncalc";
import { parseCalendarDate } from "../core/CalendarDate";
import { getGameDate } from "../core/GameTime";
import { Moon } from "./Moon";
import { shouldUpdateSolarLocation } from "./SolarLocation";
import { StarField } from "./StarField";
import {
  resumeVegetationShadowReceivers,
  SHADOW_DARKNESS,
  suspendVegetationShadowReceivers,
} from "../vegetation/VegetationShadowReceiver";

const SUN_DISTANCE = 2000;
const SUN_ANGULAR_RADIUS = (0.2666 * Math.PI) / 180;
/** Keeps accelerated sky motion sub-pixel instead of stepping at the horizon. */
const ATMOSPHERE_UPDATE_INTERVAL_MS = 5_000;
/** Expensive static render targets do not need the visual sky's faster cadence. */
const SHADOW_UPDATE_INTERVAL_MS = 60_000;
/**
 * The shadow frustum spans the complete streamed vegetation ring, so 2048
 * leaves building silhouettes visibly quantized. Shadows are cached between
 * streaming and sun updates, making extra map resolution cheaper than it
 * would be for a conventional per-frame shadow pass.
 */
const PREFERRED_SHADOW_MAP_SIZE = 4096;
/** Retain a small guard band without Babylon's resolution-heavy 10% default. */
const SHADOW_ORTHO_SCALE = 0.02;
/** A restrained source size softens quantization without washing out foliage. */
const SHADOW_LIGHT_SIZE_UV_RATIO = 0.025;
/**
 * The sky reflection only has to survive being seen in a rippling surface, so
 * a small cube is plenty and keeps the six extra faces off the frame budget.
 */
const SKY_PROBE_SIZE = 128;
const MIN_AMBIENT_INTENSITY = 0.32;

/** Mutable output used to share the current sky lighting without allocations. */
export interface SolarLightingSnapshot {
  sunDirection: Vector3;
  sunColor: Color3;
  skyColor: Color3;
  groundColor: Color3;
}

/** Keeps the visible sun and scene lighting aligned with the accelerated game clock. */
export class SolarLighting {
  private readonly skyMesh: Mesh;
  private readonly sunMesh: Mesh;

  private readonly scene: Scene;
  private readonly directLight: DirectionalLight;
  private readonly ambientLight: HemisphericLight;
  private readonly shadows: ShadowGenerator;
  private readonly shadowOnlyCasters = new Set<Mesh>();
  private readonly skyMaterial: SkyMaterial;
  private readonly horizonMaterial: ShaderMaterial;
  private readonly moon: Moon;
  private readonly starField: StarField;
  private readonly skyProbe?: ReflectionProbe;
  private latitude: number;
  private longitude: number;
  private lastAtmosphereUpdate = 0;
  private lastShadowUpdate = 0;
  private calendarDate?: string;
  private timeOfDayHours?: number;

  constructor(scene: Scene, latitude: number, longitude: number) {
    this.scene = scene;
    this.latitude = latitude;
    this.longitude = longitude;

    this.ambientLight = new HemisphericLight(
      "skyAmbientLight",
      Vector3.Up(),
      scene,
    );
    this.ambientLight.diffuse = new Color3(0.64, 0.72, 0.86);
    this.ambientLight.groundColor = new Color3(0.13, 0.14, 0.18);

    this.directLight = new DirectionalLight(
      "sunLight",
      new Vector3(0, -1, 0),
      scene,
    );
    this.directLight.diffuse = new Color3(1, 0.94, 0.82);
    this.directLight.specular = new Color3(1, 0.96, 0.88);
    // Fit directional shadow depth to the actual caster bounds. Falling back
    // to the camera's very large maxZ turns a small normalized depth bias into
    // metres of separation, so shadows only survive at grazing sun angles.
    this.directLight.autoCalcShadowZBounds = true;
    this.directLight.autoUpdateExtends = true;
    this.directLight.shadowOrthoScale = SHADOW_ORTHO_SCALE;

    // A float depth texture can also be sampled by the custom vegetation
    // receiver shaders. PCSS retains that regular depth target while using a
    // comparison sampler for built-in materials. Unlike the old four-tap
    // Poisson filter, its denser kernel does not expose four obvious shade
    // bands across broad building shadows.
    // Prefer packed depth on WebGPU so the shadow target stays on Babylon's
    // most widely supported native pipeline.
    const shadowMapSize = Math.min(
      PREFERRED_SHADOW_MAP_SIZE,
      scene.getEngine().getCaps().maxTextureSize,
    );
    this.shadows = new ShadowGenerator(
      shadowMapSize,
      this.directLight,
      !scene.getEngine().isWebGPU,
    );
    this.shadows.useContactHardeningShadow = true;
    // Far grass fades through alpha blending; without this the generator would
    // drop every blended caster from the shadow map entirely.
    this.shadows.transparencyShadow = true;
    this.shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    this.shadows.contactHardeningLightSizeUVRatio = SHADOW_LIGHT_SIZE_UV_RATIO;
    this.shadows.darkness = SHADOW_DARKNESS;
    this.shadows.bias = 0.0005;
    this.shadows.normalBias = 0.02;
    const shadowMap = this.shadows.getShadowMap();
    shadowMap?.onBeforeBindObservable.add(() => {
      suspendVegetationShadowReceivers(scene, shadowMap);
    });
    shadowMap?.onBeforeRenderObservable.add(() => {
      for (const mesh of this.shadowOnlyCasters) {
        if (!mesh.isDisposed()) mesh.isVisible = true;
      }
    });
    shadowMap?.onAfterRenderObservable.add(() => {
      for (const mesh of this.shadowOnlyCasters) {
        if (!mesh.isDisposed()) mesh.isVisible = false;
      }
    });
    shadowMap?.onAfterUnbindObservable.add(() => {
      resumeVegetationShadowReceivers(scene);
    });
    this.skyMesh = MeshBuilder.CreateSphere(
      "sky",
      { diameter: SUN_DISTANCE * 1.8, segments: 32 },
      scene,
    );
    this.skyMesh.isPickable = false;
    this.skyMesh.infiniteDistance = true;
    this.skyMaterial = new SkyMaterial("skyMaterial", scene);
    this.skyMaterial.backFaceCulling = false;
    this.skyMaterial.useSunPosition = true;
    this.skyMaterial.turbidity = 5;
    this.skyMaterial.rayleigh = 2.2;
    this.skyMaterial.mieCoefficient = 0.008;
    this.skyMaterial.mieDirectionalG = 0.82;
    this.skyMaterial.fogEnabled = false;
    this.skyMesh.material = this.skyMaterial;

    const horizonMesh = MeshBuilder.CreateSphere(
      "fogHorizon",
      { diameter: SUN_DISTANCE * 1.7, segments: 32 },
      scene,
    );
    horizonMesh.isPickable = false;
    horizonMesh.infiniteDistance = true;
    // Transparent sky layers render by alphaIndex. Keep atmospheric haze in
    // front of the stars so the horizon does not remain unnaturally crisp.
    horizonMesh.alphaIndex = 1;
    this.horizonMaterial = new ShaderMaterial(
      "fogHorizonMaterial",
      scene,
      {
        vertexSource: `
          precision highp float;
          attribute vec3 position;
          uniform mat4 worldViewProjection;
          varying vec3 direction;
          void main(void) {
            direction = position;
            gl_Position = worldViewProjection * vec4(position, 1.0);
          }
        `,
        fragmentSource: `
          precision highp float;
          varying vec3 direction;
          uniform vec3 horizonColor;
          void main(void) {
            float alpha = 1.0 - smoothstep(0.0, 0.22, abs(normalize(direction).y));
            gl_FragColor = vec4(horizonColor, alpha);
          }
        `,
      },
      {
        attributes: ["position"],
        uniforms: ["worldViewProjection", "horizonColor"],
        needAlphaBlending: true,
      },
    );
    this.horizonMaterial.backFaceCulling = false;
    this.horizonMaterial.disableDepthWrite = true;
    horizonMesh.material = this.horizonMaterial;

    const radius = Math.tan(SUN_ANGULAR_RADIUS) * SUN_DISTANCE;
    this.sunMesh = MeshBuilder.CreateSphere(
      "sun",
      { diameter: radius * 2, segments: 24 },
      scene,
    );
    this.sunMesh.isPickable = false;
    this.sunMesh.infiniteDistance = true;

    const material = new StandardMaterial("sunMaterial", scene);
    material.disableLighting = true;
    material.fogEnabled = false;
    material.emissiveColor = new Color3(1, 0.78, 0.36);
    this.sunMesh.material = material;
    this.starField = new StarField(scene);
    this.moon = new Moon(scene);

    // Reflective surfaces need the sky as an environment, and the sky here is
    // a procedural dome rather than a loaded cube map. Capturing it into a
    // probe costs six small renders, and only when the sun has actually moved.
    // Keep the screen-space star quads out of the cube pass: binding their
    // shared material against a 128 px face can leave that viewport size on
    // the visible pass for one frame, making the whole star field flash large
    // and blurry. Stars are sub-pixel detail in the water reflection anyway.
    if (!scene.getEngine().isWebGPU) {
      this.skyProbe = new ReflectionProbe("skyProbe", SKY_PROBE_SIZE, scene);
      this.skyProbe.renderList?.push(
        this.skyMesh,
        horizonMesh,
        this.sunMesh,
      );
      this.skyProbe.cubeTexture.refreshRate =
        RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    }

    this.update(this.currentDate, true);
    scene.onBeforeRenderObservable.add(() => this.update(this.currentDate));
  }

  /** The captured sky, for materials that reflect their surroundings. */
  get skyReflectionTexture(): RenderTargetTexture | null {
    return this.skyProbe?.cubeTexture ?? null;
  }

  /** Copies the colors used by custom sky-lit materials. */
  copyLightingTo(result: SolarLightingSnapshot): void {
    result.sunDirection.copyFrom(this.directLight.direction).scaleInPlace(-1).normalize();
    if (this.directLight.isEnabled()) {
      result.sunColor.copyFrom(this.directLight.diffuse).scaleInPlace(this.directLight.intensity);
    } else {
      result.sunColor.set(0, 0, 0);
    }
    result.skyColor.copyFrom(this.ambientLight.diffuse).scaleInPlace(this.ambientLight.intensity);
    result.groundColor.copyFrom(this.ambientLight.groundColor).scaleInPlace(this.ambientLight.intensity);
  }

  /** The local simulation timestamp currently driving the sky. */
  get currentDate(): Date {
    const date = getGameDate();
    const calendarDate = this.calendarDate
      ? parseCalendarDate(this.calendarDate)
      : undefined;
    if (calendarDate) {
      date.setFullYear(calendarDate.year, calendarDate.month - 1, calendarDate.day);
    }
    if (this.timeOfDayHours !== undefined) {
      const hours = Math.floor(this.timeOfDayHours);
      const minutes = Math.round((this.timeOfDayHours - hours) * 60);
      date.setHours(hours, minutes, 0, 0);
    }
    return date;
  }

  setLocation(latitude: number, longitude: number): void {
    if (!shouldUpdateSolarLocation(
      this.latitude,
      this.longitude,
      latitude,
      longitude,
    )) return;
    this.latitude = latitude;
    this.longitude = longitude;
    this.update(this.currentDate, true);
  }

  /** Fixes the calendar date, or resumes the live game date when omitted. */
  setDate(date?: string): void {
    this.calendarDate = date && parseCalendarDate(date) ? date : undefined;
    this.update(this.currentDate, true);
  }

  /** Fixes the sun to a clock time, or resumes the live game clock when omitted. */
  setTimeOfDay(hours?: number): void {
    this.timeOfDayHours = hours;
    this.update(this.currentDate, true);
  }

  setShadowCasters(meshes: Mesh[]): void {
    const shadowMap = this.shadows.getShadowMap();
    if (shadowMap) shadowMap.renderList = [];
    this.shadowOnlyCasters.clear();

    for (const mesh of meshes) {
      const shadowOnly = mesh.metadata?.shadowOnly === true;
      mesh.receiveShadows = !shadowOnly;
      if (shadowOnly) {
        mesh.isVisible = false;
        this.shadowOnlyCasters.add(mesh);
      }
      this.shadows.addShadowCaster(mesh);
    }
    // Babylon caches a directional shadow transform independently of the RTT
    // render list. A location rebuild replaces every caster, so invalidate the
    // old projection before replacement vegetation samples the shadow matrix.
    this.directLight.forceProjectionMatrixCompute();
    this.refreshStaticShadows();
  }

  private update(date: Date, force = false): void {
    const now = date.getTime();
    const atmosphereElapsed = now - this.lastAtmosphereUpdate;
    const shadowElapsed = now - this.lastShadowUpdate;
    const updateAtmosphere = force || atmosphereElapsed < 0 ||
      atmosphereElapsed >= ATMOSPHERE_UPDATE_INTERVAL_MS;
    const updateShadowTargets = force || shadowElapsed < 0 ||
      shadowElapsed >= SHADOW_UPDATE_INTERVAL_MS;
    if (!updateAtmosphere && !updateShadowTargets) return;

    const position = SunCalc.getPosition(
      date,
      this.latitude,
      this.longitude,
    );
    // SunCalc 2.x returns degrees clockwise from north.
    const altitude = (position.altitude * Math.PI) / 180;
    const azimuth = (position.azimuth * Math.PI) / 180;
    const cosAltitude = Math.cos(altitude);

    // Scene +X is east and +Z is north.
    const towardSun = new Vector3(
      Math.sin(azimuth) * cosAltitude,
      Math.sin(altitude),
      Math.cos(azimuth) * cosAltitude,
    ).normalize();
    const elevationDegrees = position.altitude;
    const daylight = elevationDegrees > 0;
    const elevationFactor = Math.max(0, Math.sin(altitude));
    if (updateAtmosphere) {
      this.lastAtmosphereUpdate = now;
      this.sunMesh.position.copyFrom(towardSun.scale(SUN_DISTANCE));
      this.skyMaterial.sunPosition.copyFrom(towardSun.scale(SUN_DISTANCE));
      this.moon.update(date, towardSun, elevationDegrees);
      this.starField.update(
        date,
        this.latitude,
        this.longitude,
        elevationDegrees,
      );
      // Keep the light/sampler layout stable across day/night. Removing the
      // light while Babylon hot-swaps shaders can leave the previous program
      // expecting a shadow-comparison sampler on a unit now used by an atlas.
      // Zero intensity removes sunlight without recompiling every lit material.
      this.directLight.intensity = daylight ? 0.55 + 1.55 * Math.sqrt(elevationFactor) : 0;
      this.sunMesh.setEnabled(daylight);
      // Avoid the old horizon discontinuity (0.32 -> 0.06) and retain a soft
      // ambient floor so vegetation does not collapse into black silhouettes.
      this.ambientLight.intensity = MIN_AMBIENT_INTENSITY +
        (0.82 - MIN_AMBIENT_INTENSITY) * elevationFactor;
      const twilight = Math.max(0, Math.min(1, (elevationDegrees + 6) / 12));
      this.skyMaterial.luminance = 0.06 +
        (0.72 + 0.38 * elevationFactor - 0.06) * twilight;
      this.scene.fogColor = Color3.Lerp(
        new Color3(0.035, 0.055, 0.105),
        new Color3(0.3, 0.52, 0.86),
        twilight,
      ).scale(0.75 + this.skyMaterial.luminance * 0.25);
      this.horizonMaterial.setColor3("horizonColor", this.scene.fogColor);
      this.scene.environmentIntensity = daylight
        ? 0.7 + 0.3 * elevationFactor
        : 0.24;
    }
    if (updateShadowTargets) {
      this.lastShadowUpdate = now;
      // Keep the shadow transform paired with the depth texture that was
      // rendered from it. The visible sky can move more often without making
      // receivers sample a new matrix against stale shadow depth.
      this.directLight.direction.copyFrom(towardSun.scale(-1));
      this.directLight.position.copyFrom(towardSun.scale(200));
      this.directLight.forceProjectionMatrixCompute();
      this.skyProbe?.cubeTexture.resetRefreshCounter();
      this.refreshStaticShadows();
    }
  }

  /** Re-renders once after packed vegetation instances or their LOD masks move. */
  refreshShadows(): void {
    this.refreshStaticShadows();
  }

  /** The terrain and map geometry are static, so one shadow render is enough
   * until the once-per-minute sun update changes the light direction. */
  private refreshStaticShadows(): void {
    const shadowMap = this.shadows.getShadowMap();
    if (shadowMap) {
      shadowMap.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      shadowMap.resetRefreshCounter();
    }
  }
}
