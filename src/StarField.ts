import {
  Constants,
  Mesh,
  Scene,
  ShaderMaterial,
  Vector2,
  VertexBuffer,
  VertexData,
} from "@babylonjs/core";
import { Observer, Rotation_EQJ_HOR } from "astronomy-engine";
import starCatalog from "./star-catalog.json";
import {
  horizontalToSceneRotation,
  rotateJ2000Direction,
} from "./CelestialCoordinates";
import {
  TWINKLE_ALTITUDE_EXPONENT,
  TWINKLE_HORIZON_PROBABILITY,
  TWINKLE_HORIZON_STRENGTH,
  TWINKLE_ZENITH_PROBABILITY,
  TWINKLE_ZENITH_STRENGTH,
} from "./StarTwinkle";

const STAR_DISTANCE = 1_750;
const VERTICES_PER_STAR = 4;
const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1] as const;

/** One draw-call star layer positioned from the Bright Star Catalogue. */
export class StarField {
  readonly mesh: Mesh;

  private readonly material: ShaderMaterial;
  private readonly positions: Float32Array;

  constructor(scene: Scene) {
    const starCount = starCatalog.magnitudes.length;
    this.positions = new Float32Array(starCount * VERTICES_PER_STAR * 3);
    const corners = new Float32Array(starCount * VERTICES_PER_STAR * 2);
    const magnitudes = new Float32Array(starCount * VERTICES_PER_STAR);
    const colors = new Float32Array(starCount * VERTICES_PER_STAR * 3);
    const twinkleSeeds = new Float32Array(starCount * VERTICES_PER_STAR);
    const indices = new Uint16Array(starCount * 6);

    for (let star = 0; star < starCount; star++) {
      const sourcePosition = star * 3;
      const vertexStart = star * VERTICES_PER_STAR;
      const twinkleSeed = starTwinkleSeed(
        starCatalog.positions[sourcePosition],
        starCatalog.positions[sourcePosition + 1],
        starCatalog.positions[sourcePosition + 2],
      );
      for (let corner = 0; corner < VERTICES_PER_STAR; corner++) {
        const vertex = vertexStart + corner;
        this.positions[vertex * 3] = starCatalog.positions[sourcePosition] * STAR_DISTANCE;
        this.positions[vertex * 3 + 1] = starCatalog.positions[sourcePosition + 1] * STAR_DISTANCE;
        this.positions[vertex * 3 + 2] = starCatalog.positions[sourcePosition + 2] * STAR_DISTANCE;
        corners[vertex * 2] = CORNERS[corner * 2];
        corners[vertex * 2 + 1] = CORNERS[corner * 2 + 1];
        magnitudes[vertex] = starCatalog.magnitudes[star];
        colors[vertex * 3] = starCatalog.colors[sourcePosition];
        colors[vertex * 3 + 1] = starCatalog.colors[sourcePosition + 1];
        colors[vertex * 3 + 2] = starCatalog.colors[sourcePosition + 2];
        twinkleSeeds[vertex] = twinkleSeed;
      }

      const index = star * 6;
      indices[index] = vertexStart;
      indices[index + 1] = vertexStart + 1;
      indices[index + 2] = vertexStart + 2;
      indices[index + 3] = vertexStart;
      indices[index + 4] = vertexStart + 2;
      indices[index + 5] = vertexStart + 3;
    }

    this.mesh = new Mesh("stars", scene);
    const vertexData = new VertexData();
    vertexData.positions = this.positions;
    vertexData.indices = indices;
    vertexData.applyToMesh(this.mesh, true);
    this.mesh.setVerticesBuffer(new VertexBuffer(
      scene.getEngine(),
      corners,
      "corner",
      false,
      false,
      2,
    ));
    this.mesh.setVerticesBuffer(new VertexBuffer(
      scene.getEngine(),
      magnitudes,
      "magnitude",
      false,
      false,
      1,
    ));
    this.mesh.setVerticesBuffer(new VertexBuffer(
      scene.getEngine(),
      colors,
      "starColor",
      false,
      false,
      3,
    ));
    this.mesh.setVerticesBuffer(new VertexBuffer(
      scene.getEngine(),
      twinkleSeeds,
      "twinkleSeed",
      false,
      false,
      1,
    ));
    this.mesh.isPickable = false;
    this.mesh.infiniteDistance = true;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.alphaIndex = 0;

    this.material = new ShaderMaterial(
      "starMaterial",
      scene,
      {
        vertexSource: `
          precision highp float;
          attribute vec3 position;
          attribute vec2 corner;
          attribute float magnitude;
          attribute vec3 starColor;
          attribute float twinkleSeed;
          uniform mat4 worldViewProjection;
          uniform vec2 screenSize;
          uniform float sunAltitudeDegrees;
          uniform float timeSeconds;
          varying vec2 vCorner;
          varying vec3 vColor;
          varying float vAlpha;

          float hash11(float value) {
            return fract(sin(value * 12.9898) * 43758.5453);
          }

          void main(void) {
            vec4 clip = worldViewProjection * vec4(position, 1.0);
            float brightness = clamp((6.7 - magnitude) / 8.2, 0.0, 1.0);
            float pointSize = mix(1.15, 5.2, pow(brightness, 2.1));
            vec2 offset = corner * pointSize * 2.0 / screenSize;
            clip.xy += offset * clip.w;
            gl_Position = clip;

            float appearanceAltitude = -3.0 - (magnitude + 1.5) * 1.65;
            float twilight = 1.0 - smoothstep(
              appearanceAltitude,
              appearanceAltitude + 3.0,
              sunAltitudeDegrees
            );
            float horizon = smoothstep(-0.004, 0.025, position.y / ${STAR_DISTANCE.toFixed(1)});
            float altitude = clamp(position.y / ${STAR_DISTANCE.toFixed(1)}, 0.0, 1.0);
            float horizonProximity = pow(
              1.0 - altitude,
              ${TWINKLE_ALTITUDE_EXPONENT.toFixed(1)}
            );
            float cycleRate = mix(0.35, 0.75, hash11(twinkleSeed * 31.7));
            float cycleTime = timeSeconds * cycleRate + twinkleSeed * 17.0;
            float cycle = floor(cycleTime);
            float cycleProgress = fract(cycleTime);
            float eventProbability = mix(
              ${TWINKLE_ZENITH_PROBABILITY.toFixed(3)},
              ${TWINKLE_HORIZON_PROBABILITY.toFixed(3)},
              horizonProximity
            );
            float eventActive = step(
              1.0 - eventProbability,
              hash11(cycle + twinkleSeed * 173.0)
            );
            float eventEnvelope = sin(cycleProgress * 3.14159265);
            float eventPolarity = mix(
              -1.0,
              1.0,
              hash11(cycle * 7.9 + twinkleSeed * 311.0)
            );
            float eventStrength = mix(
              ${TWINKLE_ZENITH_STRENGTH.toFixed(3)},
              ${TWINKLE_HORIZON_STRENGTH.toFixed(3)},
              horizonProximity
            );
            float scintillation = 1.0 +
              eventActive * eventEnvelope * eventPolarity * eventStrength;
            vAlpha = mix(0.3, 1.0, pow(brightness, 1.35)) *
              twilight * horizon * scintillation;
            vColor = mix(vec3(1.0), starColor, 0.52);
            vCorner = corner;
          }
        `,
        fragmentSource: `
          precision highp float;
          varying vec2 vCorner;
          varying vec3 vColor;
          varying float vAlpha;

          void main(void) {
            float radius = length(vCorner);
            float disc = 1.0 - smoothstep(0.28, 1.0, radius);
            if (disc <= 0.0 || vAlpha <= 0.0) discard;
            gl_FragColor = vec4(vColor * (0.85 + 0.45 * disc), disc * vAlpha);
          }
        `,
      },
      {
        attributes: ["position", "corner", "magnitude", "starColor", "twinkleSeed"],
        uniforms: [
          "worldViewProjection",
          "screenSize",
          "sunAltitudeDegrees",
          "timeSeconds",
        ],
        needAlphaBlending: true,
      },
    );
    this.material.backFaceCulling = false;
    this.material.disableDepthWrite = true;
    this.material.alphaMode = Constants.ALPHA_ADD;
    this.material.setFloat("sunAltitudeDegrees", 90);
    const screenSize = new Vector2(1, 1);
    const animationStartedAt = performance.now();
    this.material.onBindObservable.add(() => {
      screenSize.set(
        Math.max(1, scene.getEngine().getRenderWidth()),
        Math.max(1, scene.getEngine().getRenderHeight()),
      );
      this.material.setVector2(
        "screenSize",
        screenSize,
      );
      this.material.setFloat(
        "timeSeconds",
        Math.max(0, performance.now() - animationStartedAt) / 1_000,
      );
    });
    this.mesh.material = this.material;
  }

  update(date: Date, latitude: number, longitude: number, sunAltitudeDegrees: number): void {
    const rotation = horizontalToSceneRotation(
      Rotation_EQJ_HOR(date, new Observer(latitude, longitude, 0)).rot,
    );
    const starCount = starCatalog.magnitudes.length;
    for (let star = 0; star < starCount; star++) {
      const source = star * 3;
      const direction = rotateJ2000Direction(
        rotation,
        starCatalog.positions[source],
        starCatalog.positions[source + 1],
        starCatalog.positions[source + 2],
      );
      const vertexStart = star * VERTICES_PER_STAR;
      for (let corner = 0; corner < VERTICES_PER_STAR; corner++) {
        const target = (vertexStart + corner) * 3;
        this.positions[target] = direction.x * STAR_DISTANCE;
        this.positions[target + 1] = direction.y * STAR_DISTANCE;
        this.positions[target + 2] = direction.z * STAR_DISTANCE;
      }
    }
    this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.positions, false, false);
    this.material.setFloat("sunAltitudeDegrees", sunAltitudeDegrees);
  }
}

function starTwinkleSeed(x: number, y: number, z: number): number {
  const value = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43_758.5453;
  return value - Math.floor(value);
}
