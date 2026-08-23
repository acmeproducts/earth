import {
  Constants,
  Mesh,
  MeshBuilder,
  Scene,
  ShaderMaterial,
  Texture,
  Vector3,
} from "@babylonjs/core";
import {
  fictionalMoonPhase,
  fictionalMoonSkyVisibility,
} from "./FictionalMoon";

const MOON_DISTANCE = 1_725;
const MOON_ANGULAR_DIAMETER_DEGREES = 1.2;
const MOON_SIZE = 2 * Math.tan(
  MOON_ANGULAR_DIAMETER_DEGREES * Math.PI / 360,
) * MOON_DISTANCE;

/** A fictional orbit and phase renderer with a generated crater albedo. */
export class Moon {
  readonly mesh: Mesh;

  private readonly material: ShaderMaterial;

  constructor(scene: Scene) {
    this.mesh = MeshBuilder.CreatePlane("moon", { size: 1 }, scene);
    this.mesh.scaling.set(MOON_SIZE, MOON_SIZE, 1);
    this.mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.mesh.infiniteDistance = true;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.alphaIndex = 0;

    const texture = new Texture(
      new URL("../assets/sky/fictional-moon.jpg", import.meta.url).toString(),
      scene,
      false,
      true,
      Texture.BILINEAR_SAMPLINGMODE,
    );
    texture.name = "fictionalMoonSurface";
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;

    this.material = new ShaderMaterial(
      "moonMaterial",
      scene,
      {
        vertexSource: `
          precision highp float;
          attribute vec3 position;
          attribute vec2 uv;
          uniform mat4 worldViewProjection;
          varying vec2 vUV;

          void main(void) {
            vUV = uv;
            gl_Position = worldViewProjection * vec4(position, 1.0);
          }
        `,
        fragmentSource: `
          precision highp float;
          varying vec2 vUV;
          uniform sampler2D moonSurface;
          uniform float phaseAngle;
          uniform float skyVisibility;

          void main(void) {
            vec2 disc = (vUV - 0.5) * 2.0;
            float radiusSquared = dot(disc, disc);
            if (radiusSquared >= 1.0) discard;

            float sphereDepth = sqrt(max(0.0, 1.0 - radiusSquared));
            vec3 surfaceNormal = normalize(vec3(disc, sphereDepth));
            vec3 phaseLight = normalize(vec3(
              sin(phaseAngle),
              0.0,
              cos(phaseAngle)
            ));
            float phaseLighting = smoothstep(
              -0.035,
              0.055,
              dot(surfaceNormal, phaseLight)
            );
            float edge = 1.0 - smoothstep(0.965, 1.0, radiusSquared);
            float sourceLuminance = dot(
              texture2D(moonSurface, vUV).rgb,
              vec3(0.2126, 0.7152, 0.0722)
            );
            vec3 albedo = vec3(0.9, 0.94, 1.0) * sourceLuminance;
            float earthshine = 0.025 + 0.025 * sphereDepth;
            float illumination = mix(earthshine, 1.0, phaseLighting);
            float limbDarkening = 0.76 + 0.24 * sphereDepth;
            gl_FragColor = vec4(
              albedo * illumination * limbDarkening * 1.15,
              edge * skyVisibility
            );
          }
        `,
      },
      {
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection", "phaseAngle", "skyVisibility"],
        samplers: ["moonSurface"],
        needAlphaBlending: true,
      },
    );
    this.material.backFaceCulling = false;
    this.material.disableDepthWrite = true;
    this.material.alphaMode = Constants.ALPHA_ADD;
    this.material.setTexture("moonSurface", texture);
    this.material.setFloat("phaseAngle", 0);
    this.material.setFloat("skyVisibility", 0);
    this.mesh.material = this.material;
  }

  update(date: Date, towardSun: Vector3, sunAltitudeDegrees: number): void {
    // A fictional anti-solar orbit keeps the moon available as a night-sky
    // landmark; its faster phase cycle is intentionally unrelated to it.
    this.mesh.position.copyFrom(towardSun).scaleInPlace(-MOON_DISTANCE);
    this.material.setFloat("phaseAngle", fictionalMoonPhase(date) * Math.PI * 2);
    this.material.setFloat(
      "skyVisibility",
      fictionalMoonSkyVisibility(sunAltitudeDegrees),
    );
  }
}
