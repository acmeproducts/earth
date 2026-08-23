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
import { parseCalendarDate } from "./CalendarDate";
import { Moon } from "./Moon";
import { StarField } from "./StarField";

const SUN_DISTANCE = 2000;
const SUN_ANGULAR_RADIUS = (0.2666 * Math.PI) / 180;
const UPDATE_INTERVAL_MS = 60_000;
/**
 * The sky reflection only has to survive being seen in a rippling surface, so
 * a small cube is plenty and keeps the six extra faces off the frame budget.
 */
const SKY_PROBE_SIZE = 128;
const MIN_AMBIENT_INTENSITY = 0.24;

/** Mutable output used to share the current sky lighting without allocations. */
export interface SolarLightingSnapshot {
  sunDirection: Vector3;
  sunColor: Color3;
  skyColor: Color3;
  groundColor: Color3;
}

/** Keeps the visible sun and scene lighting aligned with the real sky. */
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
  private lastUpdate = 0;
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
    this.ambientLight.groundColor = new Color3(0.08, 0.09, 0.12);

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

    // A float depth texture can also be sampled by the custom vegetation
    // receiver shaders. Poisson filtering keeps the built-in terrain receiver
    // compatible with that regular sampler path.
    // Prefer packed depth on WebGPU so the shadow target stays on Babylon's
    // most widely supported native pipeline.
    this.shadows = new ShadowGenerator(2048, this.directLight, !scene.getEngine().isWebGPU);
    this.shadows.usePoissonSampling = true;
    this.shadows.bias = 0.0005;
    this.shadows.normalBias = 0.02;
    const shadowMap = this.shadows.getShadowMap();
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
    // probe costs six small renders of three meshes, and only when the sun has
    // actually moved.
    if (!scene.getEngine().isWebGPU) {
      this.skyProbe = new ReflectionProbe("skyProbe", SKY_PROBE_SIZE, scene);
      this.skyProbe.renderList?.push(
        this.skyMesh,
        this.starField.mesh,
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
    const date = new Date();
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
    this.latitude = latitude;
    this.longitude = longitude;
    this.update(this.currentDate, true);
  }

  /** Fixes the calendar date, or resumes today's date when omitted. */
  setDate(date?: string): void {
    this.calendarDate = date && parseCalendarDate(date) ? date : undefined;
    this.update(this.currentDate, true);
  }

  /** Fixes the sun to a clock time, or resumes the live clock when omitted. */
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
    if (!force && date.getTime() - this.lastUpdate < UPDATE_INTERVAL_MS) return;
    this.lastUpdate = date.getTime();

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
    this.sunMesh.position.copyFrom(towardSun.scale(SUN_DISTANCE));
    this.skyMaterial.sunPosition.copyFrom(towardSun.scale(SUN_DISTANCE));
    this.directLight.direction.copyFrom(towardSun.scale(-1));
    this.directLight.position.copyFrom(towardSun.scale(200));
    this.directLight.forceProjectionMatrixCompute();

    const elevationDegrees = position.altitude;
    this.moon.update(date, towardSun, elevationDegrees);
    this.starField.update(
      date,
      this.latitude,
      this.longitude,
      elevationDegrees,
    );
    const daylight = elevationDegrees > 0;
    const elevationFactor = Math.max(0, Math.sin(altitude));
    this.directLight.setEnabled(daylight);
    this.directLight.intensity = 0.55 + 1.55 * Math.sqrt(elevationFactor);
    this.sunMesh.setEnabled(daylight);
    // Avoid the old horizon discontinuity (0.32 -> 0.06) and retain a soft
    // ambient floor so vegetation does not collapse into black silhouettes.
    this.ambientLight.intensity = MIN_AMBIENT_INTENSITY +
      (0.82 - MIN_AMBIENT_INTENSITY) * elevationFactor;
    const twilight = Math.max(0, Math.min(1, (elevationDegrees + 6) / 12));
    this.skyMaterial.luminance = 0.06 +
      (0.72 + 0.38 * elevationFactor - 0.06) * twilight;
    this.scene.fogColor = Color3.Lerp(
      new Color3(0.012, 0.025, 0.065),
      new Color3(0.3, 0.52, 0.86),
      twilight,
    ).scale(0.75 + this.skyMaterial.luminance * 0.25);
    this.horizonMaterial.setColor3("horizonColor", this.scene.fogColor);
    this.scene.environmentIntensity = daylight
      ? 0.7 + 0.3 * elevationFactor
      : 0.12;
    // The dome's colours were just rewritten, so the captured copy is stale.
    this.skyProbe?.cubeTexture.resetRefreshCounter();
    this.refreshStaticShadows();
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
