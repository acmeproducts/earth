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

const BARK_TEXTURE_SIZE = 512;

export type TreeBarkStyle =
  | "acacia"
  | "beech"
  | "birch"
  | "eucalyptus"
  | "fir"
  | "mangrove"
  | "maple"
  | "oak"
  | "palm"
  | "pine"
  | "spruce";

const barkTextures = new WeakMap<Scene, Map<TreeBarkStyle, DynamicTexture>>();

const BARK_SEEDS: Record<TreeBarkStyle, number> = {
  acacia: 0x41434143,
  beech: 0x42454543,
  birch: 0x42495243,
  eucalyptus: 0x45554341,
  fir: 0x46495221,
  mangrove: 0x4d414e47,
  maple: 0x4d41504c,
  oak: 0x4f414b21,
  palm: 0x50414c4d,
  pine: 0x50494e45,
  spruce: 0x53505255,
};

const BARK_BASE: Record<TreeBarkStyle, readonly [number, number, number]> = {
  acacia: [216, 202, 180],
  beech: [229, 226, 214],
  birch: [229, 226, 216],
  eucalyptus: [232, 220, 193],
  fir: [207, 199, 184],
  mangrove: [205, 192, 171],
  maple: [218, 211, 197],
  oak: [202, 190, 170],
  palm: [221, 203, 174],
  pine: [224, 190, 154],
  spruce: [211, 205, 192],
};

/** Builds and caches one seamless, deterministic birch-bark texture per scene. */
export function getBirchBarkTexture(scene: Scene): DynamicTexture {
  return getTreeBarkTexture(scene, "birch");
}

/** Builds and caches a seamless, deterministic bark texture for each species. */
export function getTreeBarkTexture(scene: Scene, species: TreeBarkStyle): DynamicTexture {
  let sceneTextures = barkTextures.get(scene);
  if (!sceneTextures) {
    sceneTextures = new Map();
    barkTextures.set(scene, sceneTextures);
  }
  const cached = sceneTextures.get(species);
  if (cached) return cached;

  const size = BARK_TEXTURE_SIZE;
  const texture = new DynamicTexture(
    `procedural${species[0].toUpperCase()}${species.slice(1)}Bark`,
    { width: size, height: size },
    scene,
    true,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  const context = texture.getContext() as unknown as CanvasRenderingContext2D;
  const pixels = context.createImageData(size, size);

  const base = BARK_BASE[species];
  const verticalSpecies = species !== "birch" && species !== "beech" && species !== "palm";
  // Periodic grain keeps both tile boundaries continuous without copying an asset.
  for (let y = 0; y < size; y++) {
    const vertical = Math.PI * 2 * y / size;
    for (let x = 0; x < size; x++) {
      const horizontal = Math.PI * 2 * x / size;
      const grain = verticalSpecies
        ? Math.sin(horizontal * 23 + Math.sin(vertical * 3) * 1.2) * 4.2
        : Math.sin(vertical * 31 + Math.sin(horizontal * 3) * 0.8) * 2.5;
      const broadMottle = Math.sin(horizontal * 4 + vertical * 2) * 3.2
        + Math.cos(horizontal * 9 - vertical * 5) * 1.8;
      const offset = (y * size + x) * 4;
      pixels.data[offset] = base[0] + grain + broadMottle;
      pixels.data[offset + 1] = base[1] + grain + broadMottle;
      pixels.data[offset + 2] = base[2] + grain + broadMottle * 0.7;
      pixels.data[offset + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);

  const random = createSeededRandom(BARK_SEEDS[species]);
  const wrapped = (draw: (xShift: number, yShift: number) => void): void => {
    for (const yShift of [-size, 0, size]) {
      for (const xShift of [-size, 0, size]) draw(xShift, yShift);
    }
  };
  const strokeHorizontal = (
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
    wrapped((xShift, yShift) => {
      context.beginPath();
      context.moveTo(x + xShift - width / 2, y + yShift);
      context.bezierCurveTo(
        x + xShift - width * 0.18, y + yShift + bend,
        x + xShift + width * 0.2, y + yShift - bend * 0.35,
        x + xShift + width / 2, y + yShift + bend * 0.15,
      );
      context.stroke();
    });
  };

  if (species === "birch" || species === "beech") {
    const contrast = species === "birch" ? 1 : 0.48;
    // Birch has papery scars; beech keeps the same horizontal grain much quieter.
    for (let index = 0; index < (species === "birch" ? 190 : 95); index++) {
      strokeHorizontal(random() * size, random() * size, 5 + random() * 25,
        (random() - 0.5) * 2.2, 0.45 + random() * 1.1,
        `rgba(58, 54, 48, ${(0.16 + random() * 0.3) * contrast})`);
    }
    for (let index = 0; index < (species === "birch" ? 24 : 8); index++) {
      const x = random() * size;
      const y = random() * size;
      const width = 25 + random() * 72;
      const bend = (random() - 0.5) * 5;
      strokeHorizontal(x, y + 1.4, width, bend, 4 + random() * 4, `rgba(65,60,52,${0.13 * contrast})`);
      strokeHorizontal(x, y, width, bend, 1.2 + random() * 2.2, `rgba(42,40,36,${0.68 * contrast})`);
      strokeHorizontal(x, y - 1.2, width * 0.76, -bend * 0.5, 0.8, `rgba(255,252,240,${0.7 * contrast})`);
    }
  } else if (species === "palm") {
    // Stacked old frond scars form irregular, fibrous rings around the stem.
    for (let band = 0; band < 22; band++) {
      const y = (band + random() * 0.45) * size / 22;
      strokeHorizontal(size * 0.5, y, size * 1.12, (random() - 0.5) * 8,
        3 + random() * 5, "rgba(86,55,31,0.42)");
      strokeHorizontal(size * 0.5, y - 2, size * 1.08, 0,
        1 + random() * 2, "rgba(247,225,185,0.46)");
    }
  } else if (species === "eucalyptus") {
    // Long peeling ribbons alternate fresh cream bark and weathered cinnamon strips.
    for (let strip = 0; strip < 32; strip++) {
      const x = random() * size;
      const width = 7 + random() * 26;
      context.lineCap = "round";
      context.lineWidth = width;
      context.strokeStyle = random() < 0.55 ? "rgba(255,242,207,0.48)" : "rgba(139,91,52,0.34)";
      wrapped((xShift, yShift) => {
        context.beginPath();
        context.moveTo(x + xShift, yShift - 10);
        context.bezierCurveTo(x + xShift + 18, yShift + size * 0.3,
          x + xShift - 16, yShift + size * 0.7, x + xShift + 8, yShift + size + 10);
        context.stroke();
      });
    }
  } else {
    const deep = species === "oak" || species === "mangrove" || species === "fir";
    const warm = species === "pine" || species === "acacia";
    // Furrows split into staggered plates: broad and deep on oak/mangrove/fir,
    // smaller and warmer on pine/acacia, and fine on maple/spruce.
    const furrows = deep ? 34 : 46;
    for (let groove = 0; groove < furrows; groove++) {
      const x = (groove + random() * 0.8) * size / furrows;
      const sway = 5 + random() * (deep ? 20 : 11);
      context.lineCap = "round";
      context.lineWidth = (deep ? 3.5 : 1.7) + random() * (deep ? 5 : 3);
      context.strokeStyle = warm ? "rgba(91,52,29,0.5)" : "rgba(61,54,44,0.48)";
      wrapped((xShift, yShift) => {
        context.beginPath();
        context.moveTo(x + xShift, yShift - 8);
        context.bezierCurveTo(x + xShift + sway, yShift + size * 0.28,
          x + xShift - sway, yShift + size * 0.72, x + xShift + sway * 0.25, yShift + size + 8);
        context.stroke();
      });
    }
    const plateCount = deep ? 85 : 125;
    for (let plate = 0; plate < plateCount; plate++) {
      const x = random() * size;
      const y = random() * size;
      const width = 7 + random() * (deep ? 24 : 15);
      strokeHorizontal(x, y, width, (random() - 0.5) * 5,
        0.8 + random() * 2.1, warm ? "rgba(246,204,151,0.32)" : "rgba(241,230,207,0.25)");
    }
  }

  texture.gammaSpace = false;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.update(false);
  sceneTextures.set(species, texture);
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
