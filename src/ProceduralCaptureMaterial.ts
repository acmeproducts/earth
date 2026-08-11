import {
  Color3,
  DirectionalLight,
  DynamicTexture,
  HemisphericLight,
  Mesh,
  Scene,
  ShaderMaterial,
  Texture,
  Vector3,
} from "@babylonjs/core";
import { createSeededRandom } from "./Random";

const BIRCH_BARK_TEXTURE_SIZE = 512;
const birchBarkTextures = new WeakMap<Scene, DynamicTexture>();

/** Builds and caches one seamless, deterministic birch-bark texture per scene. */
export function getBirchBarkTexture(scene: Scene): DynamicTexture {
  const cached = birchBarkTextures.get(scene);
  if (cached) return cached;

  const size = BIRCH_BARK_TEXTURE_SIZE;
  const texture = new DynamicTexture(
    "proceduralBirchBark",
    { width: size, height: size },
    scene,
    true,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  const context = texture.getContext() as unknown as CanvasRenderingContext2D;
  const pixels = context.createImageData(size, size);

  // Periodic fibers keep both tile boundaries continuous without copying an asset.
  for (let y = 0; y < size; y++) {
    const vertical = Math.PI * 2 * y / size;
    for (let x = 0; x < size; x++) {
      const horizontal = Math.PI * 2 * x / size;
      const paperFiber = Math.sin(vertical * 31 + Math.sin(horizontal * 3) * 0.8) * 2.2;
      const broadMottle = Math.sin(horizontal * 4 + vertical * 2) * 2.5
        + Math.cos(horizontal * 9 - vertical * 5) * 1.4;
      const offset = (y * size + x) * 4;
      pixels.data[offset] = 229 + paperFiber + broadMottle;
      pixels.data[offset + 1] = 226 + paperFiber + broadMottle;
      pixels.data[offset + 2] = 216 + paperFiber + broadMottle * 0.7;
      pixels.data[offset + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);

  const random = createSeededRandom(0x42495243);
  const strokeWrapped = (
    x: number,
    y: number,
    width: number,
    bend: number,
    lineWidth: number,
    color: string,
  ): void => {
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.lineCap = "round";
    for (const shift of [-size, 0, size]) {
      context.beginPath();
      context.moveTo(x + shift - width / 2, y);
      context.bezierCurveTo(
        x + shift - width * 0.18,
        y + bend,
        x + shift + width * 0.2,
        y - bend * 0.35,
        x + shift + width / 2,
        y + bend * 0.15,
      );
      context.stroke();
    }
  };

  // Fine lenticels establish scale; the sparse layered scars give the bark character.
  for (let index = 0; index < 190; index++) {
    strokeWrapped(
      random() * size,
      7 + random() * (size - 14),
      5 + random() * 24,
      (random() - 0.5) * 2.2,
      0.45 + random() * 1.1,
      `rgba(72, 67, 58, ${0.2 + random() * 0.32})`,
    );
  }
  for (let index = 0; index < 24; index++) {
    const x = random() * size;
    const y = 12 + random() * (size - 24);
    const width = 25 + random() * 72;
    const bend = (random() - 0.5) * 5;
    strokeWrapped(x, y + 1.4, width, bend, 4 + random() * 4, "rgba(70, 64, 55, 0.16)");
    strokeWrapped(x, y, width, bend, 1.2 + random() * 2.2, "rgba(48, 45, 40, 0.68)");
    strokeWrapped(x, y - 1.2, width * 0.76, -bend * 0.5, 0.8, "rgba(250, 247, 237, 0.72)");
  }
  for (let index = 0; index < 70; index++) {
    strokeWrapped(
      random() * size,
      6 + random() * (size - 12),
      18 + random() * 85,
      (random() - 0.5) * 1.5,
      0.35 + random() * 0.6,
      `rgba(255, 253, 244, ${0.12 + random() * 0.22})`,
    );
  }

  texture.gammaSpace = false;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.update(false);
  birchBarkTextures.set(scene, texture);
  return texture;
}

/** Preserves capture colors and optionally gives live models soft sun lighting. */
export function createVertexColorCaptureMaterial(
  scene: Scene,
  name: string,
  liveLighting = false,
  leafTextureUrl?: string,
  barkTexture?: Texture,
  lowLightAlbedoScale = 1,
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
        attribute vec2 uv;
        #ifdef THIN_INSTANCES
        attribute float instanceOcclusion;
        attribute vec3 vegetationColor;
        attribute float instanceLodBlend;
        #endif
        uniform mat4 viewProjection;
        uniform float modelHeight;
        #include<instancesDeclaration>
        varying vec4 vColor;
        varying vec2 vUv;
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
          vUv = uv;
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
        varying vec2 vUv;
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
        uniform float leafTextureEnabled;
        uniform float barkTextureEnabled;
        uniform float lowLightAlbedoScale;
        uniform sampler2D leafTexture;
        uniform sampler2D barkTexture;
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
          vec3 surfaceColor = vColor.rgb;
          if (vUv.x >= 1.5) {
            if (barkTextureEnabled > 0.5) {
              surfaceColor *= texture2D(barkTexture, vec2(vUv.x - 2.0, vUv.y)).rgb;
            }
          } else if (leafTextureEnabled > 0.5 && vUv.x >= 0.0) {
            vec4 leafSample = texture2D(leafTexture, vUv);
            if (leafSample.a < 0.5) discard;
            surfaceColor *= leafSample.rgb;
          }
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
          float sceneBrightness = max(
            max(skyColor.r, max(skyColor.g, skyColor.b)),
            max(sunColor.r, max(sunColor.g, sunColor.b))
          );
          float lowLightBlend = (1.0 - smoothstep(0.22, 0.58, sceneBrightness))
            * lightingEnabled;
          surfaceColor *= mix(1.0, lowLightAlbedoScale, lowLightBlend);
          float petalMask = smoothstep(0.68, 0.86, min(surfaceColor.r, min(surfaceColor.g, surfaceColor.b)));
          vec3 instanceColor = mix(surfaceColor, surfaceColor * vInstanceColor, petalMask);
          gl_FragColor = vec4(instanceColor * lighting, 1.0);
        }
      `,
    },
    {
      attributes: ["position", "normal", "color", "uv", "instanceOcclusion", "vegetationColor", "instanceLodBlend"],
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
        "leafTextureEnabled",
        "barkTextureEnabled",
        "lowLightAlbedoScale",
      ],
      samplers: ["leafTexture", "barkTexture"],
      needAlphaBlending: false,
    },
  );
  material.backFaceCulling = false;
  material.setFloat("lightingEnabled", liveLighting ? 1 : 0);
  material.setFloat("modelHeight", 1);
  material.setFloat("ambientOcclusionStrength", 1);
  material.setFloat("leafTextureEnabled", 0);
  material.setFloat("barkTextureEnabled", barkTexture ? 1 : 0);
  material.setFloat("lowLightAlbedoScale", lowLightAlbedoScale);
  if (leafTextureUrl) {
    const leafTexture = new Texture(
      leafTextureUrl,
      scene,
      false,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
      () => { material.setFloat("leafTextureEnabled", 1); },
      () => {
        material.setFloat("leafTextureEnabled", 0);
        leafTexture.dispose();
      },
    );
    leafTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
    leafTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
    material.setTexture("leafTexture", leafTexture);
  }
  if (barkTexture) {
    material.setTexture("barkTexture", barkTexture);
  }

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
