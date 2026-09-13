import { Color3, Mesh, Scene, Vector3, VertexData } from "@babylonjs/core";
import {
  createImpostorAssetProvider,
  IMPOSTOR_CUBE_FACES,
} from "./Impostor";
import type { ImpostorAssetLease, ImpostorVariant } from "./Impostor";
import {
  createVertexColorCaptureMaterial,
  scaleVertexColorModel,
} from "./procedural/ProceduralCaptureMaterial";
import { createSeededRandom } from "./Random";

const SOURCE_HEIGHT = 1.9;
const CAPTURE_DIAMETER = 3.1;
const STEM_COUNT = 14;
const STEM = new Color3(0.13, 0.34, 0.085);
const LEAF_BASE = new Color3(0.16, 0.39, 0.09);
const LEAF_TIP = new Color3(0.29, 0.5, 0.13);
const SEED_HEAD = new Color3(0.63, 0.53, 0.34);
const DAISY_STEM = new Color3(0.12, 0.36, 0.08);
const DAISY_CENTER = new Color3(1, 0.67, 0.035);
// Ordered as a hue ramp so the +/-1 drift inside one clump stays within a
// plausible species range instead of jumping from cream to violet mid-stem.
const BLOOM_PALETTES: ReadonlyArray<readonly [Color3, Color3]> = [
  [new Color3(0.66, 0.63, 0.46), new Color3(1, 0.98, 0.91)],
  [new Color3(0.68, 0.58, 0.15), new Color3(1, 0.94, 0.55)],
  [new Color3(0.72, 0.45, 0.06), new Color3(1, 0.82, 0.27)],
  [new Color3(0.68, 0.2, 0.24), new Color3(1, 0.55, 0.48)],
  [new Color3(0.48, 0.055, 0.22), new Color3(0.96, 0.35, 0.61)],
  [new Color3(0.54, 0.12, 0.38), new Color3(0.96, 0.47, 0.78)],
  [new Color3(0.38, 0.12, 0.52), new Color3(0.79, 0.48, 0.94)],
  [new Color3(0.17, 0.19, 0.55), new Color3(0.51, 0.6, 0.96)],
];
const DAISY_PETAL_PALETTES: ReadonlyArray<readonly [Color3, Color3]> = [
  [new Color3(0.78, 0.8, 0.7), new Color3(0.98, 0.96, 0.9)],
  [new Color3(0.82, 0.55, 0.67), new Color3(1, 0.78, 0.88)],
  [new Color3(0.64, 0.57, 0.82), new Color3(0.86, 0.8, 1)],
  [new Color3(0.87, 0.65, 0.34), new Color3(1, 0.86, 0.54)],
  [new Color3(0.45, 0.52, 0.78), new Color3(0.68, 0.78, 1)],
  [new Color3(0.7, 0.28, 0.24), new Color3(0.97, 0.56, 0.44)],
];

export type PlantArchetype = "floweringSpire" | "daisyPatch" | "umbelHead";

const ARCHETYPES: readonly PlantArchetype[] = [
  "floweringSpire",
  "daisyPatch",
  "umbelHead",
];

export function plantArchetypeForVariant(variantIndex: number): PlantArchetype {
  // The impostor path passes the signed regional seed and the model path its
  // unsigned twin, so normalise first or the two LODs pick different species.
  return ARCHETYPES[(variantIndex >>> 0) % ARCHETYPES.length];
}

export function plantRenderedCaptureSize(renderHeight: number): number {
  return CAPTURE_DIAMETER * renderHeight / SOURCE_HEIGHT;
}

const plantImpostors = createImpostorAssetProvider({
  name: "plantImpostor",
  queryPrefix: "plant-impostor",
  createSource: (scene, variant) => createPlantSource(
    scene,
    false,
    variant.seed,
    plantArchetypeForVariant(variant.seed ?? 0x54414c4c),
  ),
  sourceHeight: SOURCE_HEIGHT,
  captureDiameter: CAPTURE_DIAMETER,
  faces: IMPOSTOR_CUBE_FACES,
  rotationallySymmetric: false,
  upperHemisphereOnly: true,
  sampling: {
    horizontalSamples: { default: 5, minimum: 1, maximum: 18 },
    verticalSamples: { default: 5, minimum: 1, maximum: 12 },
    resolution: { default: 112, minimum: 48, maximum: 512 },
  },
});

export function acquirePlantImpostorAssets(
  scene: Scene,
  variant: ImpostorVariant,
): Promise<ImpostorAssetLease> {
  return plantImpostors.acquireAssets(scene, undefined, variant);
}

/** Builds one varied clump of tall, fireweed-like flowering stems. */
function createPlantSource(
  scene: Scene,
  liveLighting = false,
  seed = 0x54414c4c,
  archetype: PlantArchetype = "floweringSpire",
): Mesh {
  const random = createSeededRandom(seed);
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const baseY = -SOURCE_HEIGHT / 2;
  let plantTint = new Color3(1, 1, 1);
  function varyPlantTint(): void {
    const brightness = 0.91 + random() * 0.15;
    const warmth = (random() - 0.5) * 0.075;
    plantTint = new Color3(brightness + warmth, brightness, brightness - warmth);
  }
  const paletteCenter = Math.floor(random() * BLOOM_PALETTES.length);
  const clumpLeanAngle = random() * Math.PI * 2;
  const clumpLean = new Vector3(
    Math.cos(clumpLeanAngle) * (0.035 + random() * 0.075),
    0,
    Math.sin(clumpLeanAngle) * (0.035 + random() * 0.075),
  );

  if (archetype === "daisyPatch") {
    addDaisyPatch();
  } else if (archetype === "umbelHead") {
    addUmbelStand();
  } else for (let stemIndex = 0; stemIndex < STEM_COUNT; stemIndex++) {
    varyPlantTint();
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * (0.42 + random() * 0.22);
    const base = new Vector3(Math.cos(angle) * radius, baseY, Math.sin(angle) * radius);
    const mature = random() > 0.16;
    const height = mature ? 1.2 + random() * 0.63 : 0.68 + random() * 0.5;
    const individualLean = new Vector3(
      (random() - 0.5) * 0.2,
      0,
      (random() - 0.5) * 0.2,
    ).add(clumpLean.scale(0.55 + random() * 0.9));
    const top = base.add(new Vector3(individualLean.x, height, individualLean.z));
    const stemWidth = 0.008 + random() * 0.009;
    addStem(base, top, stemWidth, STEM);

    const leafCount = 5 + Math.floor(random() * 5);
    const leafPhase = random() * Math.PI * 2;
    for (let leafIndex = 0; leafIndex < leafCount; leafIndex++) {
      const along = 0.12 + leafIndex / Math.max(1, leafCount - 1) * 0.55
        + (random() - 0.5) * 0.045;
      const leafAngle = leafPhase + leafIndex * 2.38 + (random() - 0.5) * 0.38;
      const outward = new Vector3(Math.cos(leafAngle), 0, Math.sin(leafAngle));
      const leafLength = (0.19 + random() * 0.17) * (1 - along * 0.24);
      const leafStart = Vector3.Lerp(base, top, along);
      const brightness = 0.82 + random() * 0.3;
      addLanceLeaf(
        leafStart,
        outward,
        leafLength,
        0.027 + random() * 0.022,
        (random() - 0.5) * 0.09,
        brightness,
      );
    }

    if (!mature) {
      addBud(top, 0.025 + random() * 0.018, LEAF_TIP);
      continue;
    }

    const stage = random();
    const flowerStart = 0.69 + random() * 0.07;
    const nodeCount = 7 + Math.floor(random() * 7);
    const paletteOffset = random() < 0.2 ? (random() < 0.5 ? -1 : 1) : 0;
    const palette = BLOOM_PALETTES[
      Math.max(0, Math.min(BLOOM_PALETTES.length - 1, paletteCenter + paletteOffset))
    ];
    for (let node = 0; node < nodeCount; node++) {
      const t = node / Math.max(1, nodeCount - 1);
      const along = flowerStart + t * (0.97 - flowerStart);
      const centerline = Vector3.Lerp(base, top, along);
      const nodeAngle = leafPhase + node * 2.13 + (random() - 0.5) * 0.32;
      const radial = new Vector3(Math.cos(nodeAngle), 0, Math.sin(nodeAngle));
      const spread = (0.075 * (1 - t) + 0.018) * (0.78 + random() * 0.4);
      const center = centerline.add(radial.scale(spread));
      addStem(centerline, center, 0.0025, STEM);
      const isSeed = stage > 0.82 && t < (stage - 0.82) * 4.3;
      const isBud = t > 0.69 + stage * 0.25;
      if (isSeed) {
        addBud(center, 0.018 + random() * 0.018, SEED_HEAD);
      } else if (isBud) {
        addBud(center, 0.018 + random() * 0.014, palette[0]);
      } else {
        addBlossom(center, radial, 0.032 + random() * 0.025, palette, random());
      }
    }
  }

  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.colors = colors;
  const plants = new Mesh("plantImpostorProceduralSource", scene);
  data.applyToMesh(plants);
  plants.isPickable = false;
  plants.useVertexColors = true;
  plants.material = createVertexColorCaptureMaterial(
    scene,
    "plantImpostorSourceMaterial",
    liveLighting,
  );
  return plants;

  function pushVertex(point: Vector3, color: Color3, brightness = 1): number {
    positions.push(point.x, point.y, point.z);
    colors.push(
      Math.min(1, color.r * brightness * plantTint.r),
      Math.min(1, color.g * brightness * plantTint.g),
      Math.min(1, color.b * brightness * plantTint.b),
      1,
    );
    return positions.length / 3 - 1;
  }

  /** A tapered stem with actual volume, including the fine flower stalks. */
  function addStem(start: Vector3, end: Vector3, halfWidth: number, color: Color3): void {
    const axis = end.subtract(start).normalize();
    const side = Vector3.Cross(axis,
      Math.abs(axis.y) > 0.9 ? Vector3.Right() : Vector3.Up()).normalize();
    const across = Vector3.Cross(axis, side);
    const first = positions.length / 3;
    for (let ring = 0; ring < 2; ring++) {
      for (let segment = 0; segment < 5; segment++) {
        const angle = segment * Math.PI * 2 / 5;
        const offset = side.scale(Math.cos(angle)).add(across.scale(Math.sin(angle)))
          .scale(halfWidth * (ring === 0 ? 0.8 : 0.42));
        const point = (ring === 0 ? start : end).add(offset);
        point.y = Math.max(baseY, point.y);
        pushVertex(point, color);
      }
    }
    for (let segment = 0; segment < 5; segment++) {
      const a = first + segment;
      const b = first + (segment + 1) % 5;
      indices.push(a, b, a + 5, b, b + 5, a + 5);
    }
  }

  function addLanceLeaf(
    start: Vector3,
    direction: Vector3,
    length: number,
    halfWidth: number,
    droop: number,
    brightness: number,
  ): void {
    const side = new Vector3(-direction.z, 0, direction.x);
    const vertexStart = positions.length / 3;
    const segments = 4;
    for (let segment = 0; segment <= segments; segment++) {
      const t = segment / segments;
      const profile = Math.pow(Math.sin(Math.PI * t), 0.7);
      const center = start.add(direction.scale(length * t)).add(new Vector3(
        0,
        Math.sin(Math.PI * t) * 0.035 - droop * t * t,
        0,
      ));
      const offset = side.scale(halfWidth * profile);
      const color = Color3.Lerp(LEAF_BASE, LEAF_TIP, t * 0.65);
      pushVertex(center.subtract(offset), color, brightness * 0.92);
      pushVertex(center.add(offset), color, brightness * 1.04);
    }
    for (let segment = 0; segment < segments; segment++) {
      const left = vertexStart + segment * 2;
      indices.push(left, left + 2, left + 1, left + 1, left + 2, left + 3);
    }
  }

  function addBlossom(
    center: Vector3,
    radial: Vector3,
    radius: number,
    palette: readonly [Color3, Color3],
    variation: number,
  ): void {
    const normal = radial.add(new Vector3(0, 0.45, 0)).normalize();
    addPetals(center, normal, radius, 4, palette, variation * Math.PI * 2);
    addBud(center, radius * 0.19, palette[0]);
  }

  /** Cupped, rounded petals with a raised midrib and tapered attachment. */
  function addPetals(center: Vector3, normal: Vector3, radius: number,
    count: number, palette: readonly [Color3, Color3], phase: number): void {
    const tangent = Vector3.Cross(normal,
      Math.abs(normal.y) > 0.9 ? Vector3.Right() : Vector3.Up()).normalize();
    const bitangent = Vector3.Cross(normal, tangent).normalize();
    for (let petal = 0; petal < count; petal++) {
      const angle = phase + petal * Math.PI * 2 / count;
      const direction = tangent.scale(Math.cos(angle)).add(bitangent.scale(Math.sin(angle)));
      const side = Vector3.Cross(normal, direction);
      const length = radius * (0.88 + random() * 0.2);
      const start = positions.length / 3;
      for (let segment = 0; segment <= 3; segment++) {
        const t = segment / 3;
        const width = length * 0.52 * Math.sin(Math.PI * t);
        const mid = center.add(direction.scale(length * t))
          .add(normal.scale(length * (0.22 * t * t + 0.08 * Math.sin(Math.PI * t))));
        const color = Color3.Lerp(palette[0], palette[1], Math.sqrt(t));
        pushVertex(mid.subtract(side.scale(width)), color, 0.95);
        pushVertex(mid.add(normal.scale(width * 0.15)), color);
        pushVertex(mid.add(side.scale(width)), color, 0.98);
      }
      for (let segment = 0; segment < 3; segment++) {
        const i = start + segment * 3;
        indices.push(i, i + 3, i + 1, i + 1, i + 3, i + 4,
          i + 1, i + 4, i + 2, i + 2, i + 4, i + 5);
      }
    }
  }

  function addBud(center: Vector3, radius: number, color: Color3): void {
    const bottom = pushVertex(center.add(new Vector3(0, -radius, 0)), color, 0.8);
    const tip = pushVertex(center.add(new Vector3(0, radius * 1.35, 0)), color);
    const ring = positions.length / 3;
    for (let segment = 0; segment < 6; segment++) {
      const angle = segment * Math.PI / 3;
      pushVertex(center.add(new Vector3(Math.cos(angle) * radius, 0,
        Math.sin(angle) * radius)), color, 0.9);
    }
    for (let segment = 0; segment < 6; segment++) {
      const a = ring + segment;
      const b = ring + (segment + 1) % 6;
      indices.push(bottom, a, b, tip, b, a);
    }
  }

  /** A tiny near-horizontal floret; an umbel is a flat plate built from these. */
  function addFloret(center: Vector3, radius: number, color: Color3): void {
    addPetals(center, Vector3.Up(), radius, 5, [color.scale(0.88), color], random() * Math.PI * 2);
  }

  /**
   * Cow-parsley and yarrow silhouettes: bare lower stems carrying a flat,
   * slightly domed plate of florets. Reads nothing like a spire or a daisy
   * patch from any capture angle, which is the point of a third archetype.
   */
  function addUmbelStand(): void {
    const palette = BLOOM_PALETTES[Math.floor(random() * BLOOM_PALETTES.length)];
    const stemCount = 8 + Math.floor(random() * 6);
    for (let stem = 0; stem < stemCount; stem++) {
      varyPlantTint();
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * (0.36 + random() * 0.26);
      const base = new Vector3(Math.cos(angle) * radius, baseY, Math.sin(angle) * radius);
      const height = 0.92 + random() * 0.78;
      const lean = new Vector3(
        (random() - 0.5) * 0.17,
        0,
        (random() - 0.5) * 0.17,
      ).add(clumpLean.scale(0.6 + random() * 0.85));
      const head = base.add(new Vector3(lean.x, height, lean.z));
      addStem(base, head, 0.008 + random() * 0.008, STEM);

      // Finely divided foliage sits low; the upper stem stays deliberately bare.
      const leafCount = 3 + Math.floor(random() * 4);
      const leafPhase = random() * Math.PI * 2;
      for (let leaf = 0; leaf < leafCount; leaf++) {
        // Start clear of the ground: these leaves droop, and the umbel is the
        // one archetype whose lowest leaf sits on a nearly vertical stem.
        const along = 0.14 + leaf / Math.max(1, leafCount - 1) * 0.3
          + (random() - 0.5) * 0.05;
        const leafAngle = leafPhase + leaf * 2.4 + (random() - 0.5) * 0.4;
        addLanceLeaf(
          Vector3.Lerp(base, head, along),
          new Vector3(Math.cos(leafAngle), 0, Math.sin(leafAngle)),
          0.15 + random() * 0.13,
          0.018 + random() * 0.014,
          0.015 + random() * 0.035,
          0.84 + random() * 0.28,
        );
      }

      if (random() < 0.12) {
        addBud(head, 0.03 + random() * 0.02, LEAF_TIP);
        continue;
      }

      const rayCount = 9 + Math.floor(random() * 7);
      const umbelRadius = 0.11 + random() * 0.1;
      const umbelPhase = random() * Math.PI * 2;
      const dome = 0.28 + random() * 0.34;
      for (let ray = 0; ray < rayCount; ray++) {
        const rayAngle = umbelPhase + ray / rayCount * Math.PI * 2 + (random() - 0.5) * 0.24;
        const outward = new Vector3(Math.cos(rayAngle), 0, Math.sin(rayAngle));
        const rayLength = umbelRadius * (0.7 + random() * 0.46);
        const tip = head
          .add(outward.scale(rayLength))
          .add(new Vector3(0, (umbelRadius - rayLength) * dome + 0.012, 0));
        addStem(head, tip, 0.0035 + random() * 0.002, STEM);
        const floretCount = 3 + Math.floor(random() * 3);
        for (let floret = 0; floret < floretCount; floret++) {
          const floretAngle = random() * Math.PI * 2;
          const floretSpread = rayLength * (0.1 + random() * 0.2);
          addFloret(
            tip.add(new Vector3(
              Math.cos(floretAngle) * floretSpread,
              (random() - 0.4) * 0.012,
              Math.sin(floretAngle) * floretSpread,
            )),
            0.014 + random() * 0.012,
            floret === 0 ? palette[1] : Color3.Lerp(palette[0], palette[1], 0.55 + random() * 0.45),
          );
        }
      }
    }
  }

  /** Preserves the old flower impostor's dense, short daisy-patch silhouette. */
  function addDaisyPatch(): void {
    const petalPalette = DAISY_PETAL_PALETTES[
      Math.floor(random() * DAISY_PETAL_PALETTES.length)
    ];
    for (let flower = 0; flower < 30; flower++) {
      varyPlantTint();
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * 0.9;
      const base = new Vector3(
        Math.cos(angle) * radius,
        baseY,
        Math.sin(angle) * radius,
      );
      const height = 0.36 + random() * 0.34;
      const head = base.add(new Vector3(
        (random() - 0.5) * 0.13,
        height,
        (random() - 0.5) * 0.13,
      ));
      addStem(base, head, 0.011 + random() * 0.008, DAISY_STEM);

      if (random() < 0.82) {
        const leafCenter = Vector3.Lerp(base, head, 0.3 + random() * 0.38);
        const leafAngle = random() * Math.PI * 2;
        addLanceLeaf(
          leafCenter,
          new Vector3(Math.cos(leafAngle), 0, Math.sin(leafAngle)),
          0.105 + random() * 0.075,
          0.022 + random() * 0.012,
          (random() - 0.25) * 0.035,
          0.86 + random() * 0.24,
        );
      }

      const normal = new Vector3(
        (random() - 0.5) * 0.75,
        1,
        (random() - 0.5) * 0.75,
      ).normalize();
      const tangent = Vector3.Cross(
        Math.abs(normal.y) > 0.9 ? Vector3.Right() : Vector3.Up(),
        normal,
      ).normalize();
      const bitangent = Vector3.Cross(normal, tangent).normalize();
      const petalLength = 0.072 + random() * 0.034;
      const petalWidth = petalLength * (0.36 + random() * 0.12);
      const petalCount = 8 + Math.floor(random() * 4);
      for (let petal = 0; petal < petalCount; petal++) {
        const petalAngle = petal / petalCount * Math.PI * 2 + (random() - 0.5) * 0.14;
        const direction = tangent.scale(Math.cos(petalAngle))
          .add(bitangent.scale(Math.sin(petalAngle)));
        const side = Vector3.Cross(normal, direction).normalize();
        const root = head.add(direction.scale(0.016));
        const tip = head.add(direction.scale(petalLength));
        const start = positions.length / 3;
        pushVertex(root.subtract(side.scale(petalWidth * 0.25)), petalPalette[0]);
        pushVertex(root.add(side.scale(petalWidth * 0.25)), petalPalette[0]);
        pushVertex(Vector3.Lerp(root, tip, 0.62).add(side.scale(petalWidth)), petalPalette[1]);
        pushVertex(tip, petalPalette[1]);
        pushVertex(Vector3.Lerp(root, tip, 0.62).subtract(side.scale(petalWidth)), petalPalette[1]);
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3,
          start, start + 3, start + 4);
      }

      const centerRadius = petalLength * 0.3;
      const centerPoint = head.add(normal.scale(0.008));
      const centerVertex = pushVertex(centerPoint, DAISY_CENTER);
      for (let segment = 0; segment < 10; segment++) {
        const firstAngle = segment / 10 * Math.PI * 2;
        const secondAngle = (segment + 1) / 10 * Math.PI * 2;
        const first = pushVertex(centerPoint
          .add(tangent.scale(Math.cos(firstAngle) * centerRadius))
          .add(bitangent.scale(Math.sin(firstAngle) * centerRadius)), DAISY_CENTER);
        const second = pushVertex(centerPoint
          .add(tangent.scale(Math.cos(secondAngle) * centerRadius))
          .add(bitangent.scale(Math.sin(secondAngle) * centerRadius)), DAISY_CENTER);
        indices.push(centerVertex, first, second);
      }
    }
  }
}

/** Builds the same clump geometry used to capture the impostor for near LOD. */
export function createPlantModel(
  scene: Scene,
  renderHeight: number,
  seed?: number,
  variantIndex = 0,
): Mesh {
  const plants = createPlantSource(
    scene,
    true,
    seed,
    plantArchetypeForVariant(variantIndex),
  );
  plants.name = "plantModels";
  scaleVertexColorModel(plants, renderHeight, SOURCE_HEIGHT);
  return plants;
}
