import {
  Color3,
  DirectionalLight,
  HemisphericLight,
  Mesh,
  Scene,
  ShaderMaterial,
  Vector3,
} from "@babylonjs/core";

/** Preserves capture colors and optionally gives live models soft sun lighting. */
export function createVertexColorCaptureMaterial(
  scene: Scene,
  name: string,
  liveLighting = false,
): ShaderMaterial {
  const material = new ShaderMaterial(
    name,
    scene,
    {
      vertexSource: `
        precision highp float;
        attribute vec3 position;
        attribute vec3 normal;
        attribute vec4 color;
        #ifdef THIN_INSTANCES
        attribute float instanceOcclusion;
        attribute vec3 vegetationColor;
        attribute float instanceLodBlend;
        #endif
        uniform mat4 viewProjection;
        uniform float modelHeight;
        #include<instancesDeclaration>
        varying vec4 vColor;
        varying vec3 vWorldNormal;
        varying float vHeight01;
        varying float vInstanceOcclusion;
        varying vec3 vInstanceColor;
        varying float vInstanceLodBlend;
        void main(void) {
          #include<instancesVertex>
          mat3 rotation = mat3(
            normalize(finalWorld[0].xyz),
            normalize(finalWorld[1].xyz),
            normalize(finalWorld[2].xyz)
          );
          vColor = color;
          vWorldNormal = normalize(rotation * normal);
          vHeight01 = clamp(position.y / max(modelHeight, 0.0001), 0.0, 1.0);
          #ifdef THIN_INSTANCES
          vInstanceOcclusion = instanceOcclusion;
          vInstanceColor = vegetationColor;
          vInstanceLodBlend = instanceLodBlend;
          #else
          vInstanceOcclusion = 0.0;
          vInstanceColor = vec3(1.0);
          vInstanceLodBlend = 1.0;
          #endif
          gl_Position = viewProjection * finalWorld * vec4(position, 1.0);
        }
      `,
      fragmentSource: `
        precision highp float;
        varying vec4 vColor;
        varying vec3 vWorldNormal;
        varying float vHeight01;
        varying float vInstanceOcclusion;
        varying vec3 vInstanceColor;
        varying float vInstanceLodBlend;
        uniform vec3 sunDirection;
        uniform vec3 sunColor;
        uniform vec3 skyColor;
        uniform vec3 groundColor;
        uniform float lightingEnabled;
        uniform float ambientOcclusionStrength;
        float bayer4(vec2 pixel) {
          vec2 p = mod(floor(pixel), 4.0);
          vec2 low = mod(p, 2.0);
          vec2 high = floor(p * 0.5);
          float lowValue = 2.0 * low.x + low.y * (3.0 - 4.0 * low.x);
          float highValue = 2.0 * high.x + high.y * (3.0 - 4.0 * high.x);
          return (4.0 * lowValue + highValue) / 16.0;
        }
        void main(void) {
          if (vInstanceLodBlend <= bayer4(gl_FragCoord.xy + vec2(2.0, 1.0))) discard;
          vec3 normal = normalize(vWorldNormal);
          if (normal.y < 0.0) normal = -normal;
          normal = normalize(mix(normal, vec3(0.0, 1.0, 0.0), 0.58));

          float upward = normal.y * 0.5 + 0.5;
          vec3 ambientColor = mix(groundColor, skyColor, upward);
          float direct = max(0.0, (dot(normal, sunDirection) + 0.42) / 1.42);
          vec3 lighting = clamp(
            ambientColor + sunColor * (0.16 + direct * 0.62),
            vec3(0.0),
            vec3(1.25)
          );
          float crownLight = mix(0.62, 1.10, smoothstep(0.08, 0.92, vHeight01));
          float lowerTree = 1.0 - smoothstep(0.18, 0.82, vHeight01);
          float neighborShade = 1.0
            - vInstanceOcclusion * ambientOcclusionStrength * mix(0.16, 0.48, lowerTree);
          // Keep live vegetation readable when direct sunlight has faded out.
          lighting = clamp(lighting * crownLight * neighborShade, vec3(0.18), vec3(1.25));
          lighting = mix(vec3(1.0), lighting, lightingEnabled);
          float petalMask = smoothstep(0.68, 0.86, min(vColor.r, min(vColor.g, vColor.b)));
          vec3 instanceColor = mix(vColor.rgb, vColor.rgb * vInstanceColor, petalMask);
          gl_FragColor = vec4(instanceColor * lighting, 1.0);
        }
      `,
    },
    {
      attributes: ["position", "normal", "color", "instanceOcclusion", "vegetationColor", "instanceLodBlend"],
      uniforms: [
        "world",
        "viewProjection",
        "sunDirection",
        "sunColor",
        "skyColor",
        "groundColor",
        "lightingEnabled",
        "modelHeight",
        "ambientOcclusionStrength",
      ],
      needAlphaBlending: false,
    },
  );
  material.backFaceCulling = false;
  material.setFloat("lightingEnabled", liveLighting ? 1 : 0);
  material.setFloat("modelHeight", 1);
  material.setFloat("ambientOcclusionStrength", 1);

  const black = Color3.Black();
  const fallbackSky = new Color3(0.38, 0.42, 0.48);
  const fallbackGround = new Color3(0.08, 0.09, 0.07);
  material.onBindObservable.add(() => {
    const sun = scene.lights.find((light): light is DirectionalLight => (
      light instanceof DirectionalLight && light.name === "sunLight"
    ));
    const ambient = scene.lights.find((light): light is HemisphericLight => (
      light instanceof HemisphericLight && light.name === "skyAmbientLight"
    ));

    material.setVector3(
      "sunDirection",
      sun?.isEnabled() ? sun.direction.scale(-1).normalize() : Vector3.Up(),
    );
    material.setColor3(
      "sunColor",
      sun?.isEnabled() ? sun.diffuse.scale(sun.intensity) : black,
    );
    material.setColor3(
      "skyColor",
      ambient ? ambient.diffuse.scale(ambient.intensity) : fallbackSky,
    );
    material.setColor3(
      "groundColor",
      ambient ? ambient.groundColor.scale(ambient.intensity) : fallbackGround,
    );
  });
  return material;
}

/** Sets the normalized-height range used by live vegetation model lighting. */
export function setVertexColorModelHeight(
  mesh: Mesh,
  modelHeight: number,
  ambientOcclusionStrength = 1,
): void {
  if (mesh.material instanceof ShaderMaterial) {
    mesh.material.setFloat("modelHeight", modelHeight);
    mesh.material.setFloat("ambientOcclusionStrength", ambientOcclusionStrength);
  }
}
