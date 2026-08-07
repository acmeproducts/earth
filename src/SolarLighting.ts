import {
  Color3,
  DirectionalLight,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { SkyMaterial } from "@babylonjs/materials";
import * as SunCalc from "suncalc";

const SUN_DISTANCE = 500;
const SUN_ANGULAR_RADIUS = (0.2666 * Math.PI) / 180;
const UPDATE_INTERVAL_MS = 60_000;

/** Keeps the visible sun and scene lighting aligned with the real sky. */
export class SolarLighting {
  readonly sunMesh: Mesh;

  private readonly scene: Scene;
  private readonly directLight: DirectionalLight;
  private readonly ambientLight: HemisphericLight;
  private readonly shadows: ShadowGenerator;
  private readonly skyMaterial: SkyMaterial;
  private latitude: number;
  private longitude: number;
  private lastUpdate = 0;

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

    this.shadows = new ShadowGenerator(2048, this.directLight);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.bias = 0.0005;
    this.shadows.normalBias = 0.02;

    const sky = MeshBuilder.CreateSphere(
      "sky",
      { diameter: SUN_DISTANCE * 1.8, segments: 32 },
      scene,
    );
    sky.isPickable = false;
    sky.infiniteDistance = true;
    this.skyMaterial = new SkyMaterial("skyMaterial", scene);
    this.skyMaterial.backFaceCulling = false;
    this.skyMaterial.useSunPosition = true;
    this.skyMaterial.turbidity = 5;
    this.skyMaterial.rayleigh = 2.2;
    this.skyMaterial.mieCoefficient = 0.008;
    this.skyMaterial.mieDirectionalG = 0.82;
    sky.material = this.skyMaterial;

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
    material.emissiveColor = new Color3(1, 0.78, 0.36);
    this.sunMesh.material = material;

    this.update(new Date(), true);
    scene.onBeforeRenderObservable.add(() => this.update(new Date()));
  }

  setLocation(latitude: number, longitude: number): void {
    this.latitude = latitude;
    this.longitude = longitude;
    this.update(new Date(), true);
  }

  setShadowCasters(meshes: Mesh[]): void {
    const shadowMap = this.shadows.getShadowMap();
    if (shadowMap) shadowMap.renderList = [];

    for (const mesh of meshes) {
      mesh.receiveShadows = true;
      this.shadows.addShadowCaster(mesh);
    }
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

    const elevationDegrees = position.altitude;
    const daylight = elevationDegrees > 0;
    const elevationFactor = Math.max(0, Math.sin(altitude));
    this.directLight.setEnabled(daylight);
    this.directLight.intensity = 0.55 + 1.55 * Math.sqrt(elevationFactor);
    this.sunMesh.setEnabled(daylight);
    this.ambientLight.intensity = daylight
      ? 0.32 + 0.5 * elevationFactor
      : 0.06;
    this.skyMaterial.luminance = daylight
      ? 0.72 + 0.38 * elevationFactor
      : 0.06;
    this.scene.environmentIntensity = daylight
      ? 0.7 + 0.3 * elevationFactor
      : 0.12;
  }
}
