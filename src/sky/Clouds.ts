import { Color3, Mesh, MeshBuilder, Scene, ShaderMaterial, Vector3 } from "@babylonjs/core";
import type { SolarLighting, SolarLightingSnapshot } from "./SolarLighting";
import { createCloudField, cloudCoverageShader } from "./CloudField";
import { currentWindState } from "../vegetation/Wind";

export interface CloudLayer {
  readonly mesh: Mesh;
  update(cameraPosition: Vector3): void;
  setDensity(density: number): void;
  dispose(): void;
}

export interface CloudLayerOptions {
  metersPerUnit: number;
  weatherSeed: number;
  density: number;
}

/** One continuous sheet: its world-space texture never follows camera rotation. */
export function createCloudLayer(scene: Scene, lighting: SolarLighting, options: CloudLayerOptions): CloudLayer {
  const { metersPerUnit } = options;
  const field = createCloudField(scene, metersPerUnit, options.weatherSeed);
  const mesh = MeshBuilder.CreateGround("cloudLayer", { width: 60_000 / metersPerUnit, height: 60_000 / metersPerUnit }, scene);
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.alphaIndex = 2;
  const material = new ShaderMaterial("cloudLayer", scene, {
    vertexSource: `precision highp float;
      attribute vec3 position;
      uniform mat4 world;
      uniform mat4 viewProjection;
      varying vec3 cloudWorldPosition;
      void main() {
        cloudWorldPosition = (world * vec4(position, 1.0)).xyz;
        gl_Position = viewProjection * vec4(cloudWorldPosition, 1.0);
      }`,
    fragmentSource: `precision highp float;
      varying vec3 cloudWorldPosition;
      uniform vec3 cameraPosition;
      uniform vec3 cloudColor;
      uniform vec3 fogColor;
      uniform float metersPerUnit;
      ${cloudCoverageShader}
      void main() {
        float distanceMeters = length(cloudWorldPosition - cameraPosition) * metersPerUnit;
        float fade = 1.0 - smoothstep(18000.0, 26000.0, distanceMeters);
        fade *= smoothstep(50.0, 400.0, abs(cameraPosition.y - cloudField.z) * metersPerUnit);
        float coverage = cloudCoverage(cloudWorldPosition.xz);
        vec3 color = cloudColor * mix(1.0, 0.83, coverage);
        color = mix(color, fogColor, smoothstep(10000.0, 26000.0, distanceMeters));
        gl_FragColor = vec4(color, coverage * fade * 0.94);
      }`,
  }, {
    attributes: ["position"],
    uniforms: ["world", "viewProjection", "cameraPosition", "cloudColor", "fogColor", "metersPerUnit", "cloudField", "cloudOffset"],
    samplers: ["cloudPattern"], needAlphaBlending: true,
  });
  material.backFaceCulling = false;
  material.disableDepthWrite = true;
  material.fogEnabled = false;
  mesh.material = material;
  const snapshot: SolarLightingSnapshot = {
    sunDirection: Vector3.Up(), sunColor: Color3.Black(), skyColor: Color3.Black(), groundColor: Color3.Black(),
  };
  const color = Color3.Black();
  material.onBindObservable.add(() => {
    const effect = material.getEffect();
    if (!effect || !scene.activeCamera) return;
    effect.setTexture("cloudPattern", field.texture);
    effect.setVector4("cloudField", field.parameters);
    effect.setVector2("cloudOffset", field.offset);
    effect.setVector3("cameraPosition", scene.activeCamera.globalPosition);
    effect.setColor3("cloudColor", color);
    effect.setColor3("fogColor", scene.fogColor);
    effect.setFloat("metersPerUnit", metersPerUnit);
  });
  let lastUpdate = performance.now();
  const update = (cameraPosition: Vector3): void => {
    const now = performance.now();
    const seconds = Math.max(0, Math.min(0.1, (now - lastUpdate) / 1000));
    lastUpdate = now;
    const wind = currentWindState(now);
    // Only the texture moves. Wrapping a repeat texture keeps long sessions precise.
    field.offset.x = (field.offset.x - wind.direction.x * wind.speedMetersPerSecond * seconds * field.parameters.x / metersPerUnit) % 1;
    field.offset.y = (field.offset.y - wind.direction.y * wind.speedMetersPerSecond * seconds * field.parameters.x / metersPerUnit) % 1;
    mesh.position.set(cameraPosition.x, field.parameters.z, cameraPosition.z);
    lighting.copyLightingTo(snapshot);
    field.updateSun(snapshot.sunDirection);
    color.copyFrom(snapshot.skyColor).scaleInPlace(0.72);
    color.addInPlace(snapshot.sunColor.scale(0.4));
  };
  const setDensity = (density: number): void => {
    field.parameters.y = Number.isFinite(density) ? Math.max(0, Math.min(1, density)) : 0;
    mesh.setEnabled(field.parameters.y > 0);
  };
  setDensity(options.density);
  if (scene.activeCamera) update(scene.activeCamera.globalPosition);
  return { mesh, update, setDensity, dispose() {
    mesh.dispose();
    material.dispose();
    field.dispose();
  } };
}
