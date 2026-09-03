import { Color3, Mesh, Scene, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
import {
  createVertexColorCaptureMaterial,
  setVertexColorModelHeight,
} from "./procedural/ProceduralCaptureMaterial";
import {
  createImpostorAssetProvider,
  IMPOSTOR_CUBE_FACES,
  ImpostorAssetLease,
  ImpostorVariant,
} from "./Impostor";
import { createSeededRandom } from "./Random";

const SOURCE_HEIGHT = 2.2;
const CAPTURE_DIAMETER = 4.5;

export function bushRenderedCaptureSize(renderHeight: number): number {
  return CAPTURE_DIAMETER * renderHeight / SOURCE_HEIGHT;
}
// Ordered dark-to-pale so the per-spray +/-1 drift stays inside one shrub's
// plausible foliage range while the ends read as different species entirely.
const FOLIAGE_PALETTES: ReadonlyArray<readonly [Color3, Color3]> = [
  [new Color3(0.05, 0.17, 0.1), new Color3(0.14, 0.36, 0.2)],
  [new Color3(0.075, 0.22, 0.065), new Color3(0.23, 0.5, 0.14)],
  [new Color3(0.1, 0.27, 0.07), new Color3(0.34, 0.59, 0.15)],
  [new Color3(0.13, 0.3, 0.08), new Color3(0.42, 0.65, 0.18)],
  [new Color3(0.15, 0.25, 0.065), new Color3(0.48, 0.55, 0.14)],
  [new Color3(0.19, 0.24, 0.13), new Color3(0.53, 0.57, 0.35)],
];

/** Berry and blossom accents carried by roughly a third of shrub variants. */
const ACCENT_PALETTES: ReadonlyArray<readonly [Color3, Color3]> = [
  [new Color3(0.31, 0.02, 0.05), new Color3(0.74, 0.08, 0.11)],
  [new Color3(0.07, 0.03, 0.13), new Color3(0.23, 0.15, 0.38)],
  [new Color3(0.58, 0.47, 0.15), new Color3(0.99, 0.94, 0.75)],
  [new Color3(0.5, 0.14, 0.3), new Color3(0.96, 0.62, 0.79)],
];

const bushImpostors = createImpostorAssetProvider({
  name: "bushImpostor",
  queryPrefix: "bush-impostor",
  createSource: (scene, variant) => createBushSource(scene, false, variant.seed),
  sourceHeight: SOURCE_HEIGHT,
  captureDiameter: CAPTURE_DIAMETER,
  faces: IMPOSTOR_CUBE_FACES,
  rotationallySymmetric: false,
  upperHemisphereOnly: true,
  sampling: {
    horizontalSamples: { default: 5, minimum: 1, maximum: 16 },
    verticalSamples: { default: 5, minimum: 1, maximum: 10 },
    resolution: { default: 96, minimum: 48, maximum: 512 },
  },
});

export function acquireBushImpostorAssets(
  scene: Scene,
  variant: ImpostorVariant,
): Promise<ImpostorAssetLease> {
  return bushImpostors.acquireAssets(scene, undefined, variant);
}

function createBushSource(scene: Scene, liveLighting = false, seed = 0x42555348): Mesh {
  const random = createSeededRandom(seed);
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  // Each regional seed gets a coherent but asymmetric crown. Low-frequency
  // lobes read as natural growth; exact rotational copies read as a pattern.
  const crownRadius = 0.88 + random() * 0.14;
  const growthHabit = random();
  const crownWidth = growthHabit < 0.32 ? 1.16 : growthHabit > 0.72 ? 0.82 : 1;
  const crownHeight = growthHabit < 0.32 ? 0.78 : growthHabit > 0.72 ? 1.18 : 1;
  const crownRotation = random() * Math.PI * 2;
  const lobePhase = random() * Math.PI * 2;
  const secondaryLobePhase = random() * Math.PI * 2;
  const leanAngle = random() * Math.PI * 2;
  const leanDistance = 0.05 + random() * 0.16;
  const crownLeanX = Math.cos(leanAngle) * leanDistance;
  const crownLeanZ = Math.sin(leanAngle) * leanDistance;
  const paletteCenter = Math.floor(random() * FOLIAGE_PALETTES.length);
  // Broad-leaved shrubs need fewer sprays than small-leaved ones to fill the
  // same crown, so trade the two off and keep the silhouette equally dense.
  const leafScale = 0.72 + random() * 0.66;
  const sprayCount = Math.round(258 / leafScale);
  const accent = random() < 0.34
    ? ACCENT_PALETTES[Math.floor(random() * ACCENT_PALETTES.length)]
    : undefined;
  const accentChance = accent ? 0.16 + random() * 0.34 : 0;
  const accentRadius = 0.014 + random() * 0.016;

  const radiusAtAngle = (angle: number): number => crownRadius * (
    1
    + Math.sin((angle - crownRotation) * 3 + lobePhase) * 0.13
    + Math.sin((angle - crownRotation) * 5 + secondaryLobePhase) * 0.075
  );

  // Build short compound sprays rather than grass-like ribbons. Paired side
  // leaves and a terminal leaf keep the close model legible, while random
  // orientation and gentle camber prevent the atlas from looking like cards.
  for (let spray = 0; spray < sprayCount; spray++) {
    const baseAngle = random() * Math.PI * 2;
    const edgeRadius = radiusAtAngle(baseAngle) * crownWidth;
    const radius = Math.sqrt(random()) * edgeRadius * 0.98;
    const normalizedRadius = radius / edgeRadius;
    const baseX = Math.cos(baseAngle) * radius + crownLeanX * (1 - normalizedRadius * 0.35);
    const baseZ = Math.sin(baseAngle) * radius + crownLeanZ * (1 - normalizedRadius * 0.35);
    const crownDome = Math.pow(Math.max(0, 1 - normalizedRadius * normalizedRadius), 0.42);
    const localTop = Math.min(
      SOURCE_HEIGHT / 2 - 0.07,
      -0.18 + crownDome * 1.3 * crownHeight
        + Math.sin(baseAngle * 2 + lobePhase) * 0.09
        + (random() - 0.5) * 0.13,
    );
    const localBottom = -0.94 + normalizedRadius * 0.28 + (random() - 0.5) * 0.1;
    const baseY = localBottom + Math.pow(random(), 0.72)
      * Math.max(0.08, localTop - localBottom - 0.16);
    const growthAngle = baseAngle + (random() - 0.5) * 1.3;
    const growthDirection = new Vector3(
      Math.cos(growthAngle) * (0.42 + random() * 0.28),
      0.68 + random() * 0.34,
      Math.sin(growthAngle) * (0.42 + random() * 0.28),
    ).normalize();
    const desiredLength = 0.22 + random() * 0.25;
    const availableRise = Math.max(0.08, localTop + 0.045 - baseY);
    const sprayLength = Math.min(desiredLength, availableRise / growthDirection.y);
    const sprayStart = new Vector3(baseX, baseY, baseZ);
    const sprayEnd = sprayStart.add(growthDirection.scale(sprayLength));
    const paletteOffset = random() < 0.16 ? (random() < 0.5 ? -1 : 1) : 0;
    const palette = FOLIAGE_PALETTES[
      Math.max(0, Math.min(FOLIAGE_PALETTES.length - 1, paletteCenter + paletteOffset))
    ];
    const brightness = 0.86 + random() * 0.25;

    const lateral = Vector3.Cross(growthDirection, Vector3.Up()).normalize();
    for (const along of [0.34, 0.66]) {
      const leafBase = Vector3.Lerp(sprayStart, sprayEnd, along);
      for (const side of [-1, 1]) {
        const leafDirection = growthDirection.scale(0.3)
          .add(lateral.scale(side * (0.86 + random() * 0.24)))
          .add(Vector3.Up().scale(0.08 + random() * 0.2))
          .normalize();
        const leafLength = (0.13 + random() * 0.1) * (0.9 + along * 0.18) * leafScale;
        addLeaf(
          positions,
          indices,
          colors,
          leafBase,
          leafDirection,
          leafLength,
          leafLength * (0.27 + random() * 0.1),
          random() * Math.PI * 2,
          (random() - 0.3) * 0.035,
          palette,
          brightness,
        );
      }
    }

    const terminalLength = (0.17 + random() * 0.11) * leafScale;
    addLeaf(
      positions,
      indices,
      colors,
      sprayEnd,
      growthDirection.add(lateral.scale((random() - 0.5) * 0.28)).normalize(),
      terminalLength,
      terminalLength * (0.26 + random() * 0.09),
      random() * Math.PI * 2,
      (random() - 0.3) * 0.04,
      palette,
      brightness * 1.04,
    );

    if (accent && random() < accentChance) {
      const clusterCenter = Vector3.Lerp(sprayStart, sprayEnd, 0.78 + random() * 0.2);
      const clusterCount = 3 + Math.floor(random() * 5);
      for (let berry = 0; berry < clusterCount; berry++) {
        const scatterAngle = random() * Math.PI * 2;
        const scatter = accentRadius * (1.1 + random() * 2.4);
        addAccent(
          positions,
          indices,
          colors,
          clusterCenter.add(new Vector3(
            Math.cos(scatterAngle) * scatter,
            (random() - 0.62) * scatter,
            Math.sin(scatterAngle) * scatter,
          )),
          accentRadius * (0.72 + random() * 0.58),
          accent,
          0.86 + random() * 0.3,
        );
      }
    }
  }

  const data = new VertexData();
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.colors = colors;

  const bush = new Mesh("bushImpostorProceduralSource", scene);
  data.applyToMesh(bush);
  bush.isPickable = false;
  bush.useVertexColors = true;
  bush.material = createVertexColorCaptureMaterial(
    scene,
    "bushImpostorSourceMaterial",
    liveLighting,
  );
  return bush;
}

/** Builds the original procedural geometry at the requested rendered height. */
export function createBushModel(scene: Scene, renderHeight: number, seed?: number): Mesh {
  const bush = createBushSource(scene, true, seed);
  bush.name = "bushModels";
  const positions = bush.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) throw new Error("Bush model has no position data.");

  const scale = renderHeight / SOURCE_HEIGHT;
  for (let index = 0; index < positions.length; index += 3) {
    positions[index] *= scale;
    positions[index + 1] = positions[index + 1] * scale + renderHeight / 2;
    positions[index + 2] *= scale;
  }
  bush.setVerticesData(VertexBuffer.PositionKind, positions);
  bush.refreshBoundingInfo();
  setVertexColorModelHeight(bush, renderHeight);
  return bush;
}

/** Adds one softly cupped, pointed oval leaf with a subtle center fold. */
function addLeaf(
  positions: number[],
  indices: number[],
  colors: number[],
  start: Vector3,
  direction: Vector3,
  length: number,
  halfWidth: number,
  orientation: number,
  camber: number,
  palette: readonly [Color3, Color3],
  brightness: number,
): void {
  const segments = 4;
  const vertexStart = positions.length / 3;
  const reference = Math.abs(direction.y) < 0.88 ? Vector3.Up() : Vector3.Right();
  const axisX = Vector3.Cross(direction, reference).normalize();
  const axisZ = Vector3.Cross(direction, axisX).normalize();
  const side = axisX.scale(Math.cos(orientation)).add(axisZ.scale(Math.sin(orientation)));
  const normal = Vector3.Cross(direction, side).normalize();

  for (let segment = 0; segment <= segments; segment++) {
    const t = segment / segments;
    const profile = Math.pow(Math.sin(Math.PI * t), 0.72);
    const center = start.add(direction.scale(length * t))
      .add(normal.scale(Math.sin(Math.PI * t) * camber));
    // Make the base shoulder slightly fuller than the tip for a believable
    // ovate leaf instead of a mathematically mirrored lens.
    const widthBias = 1.08 - t * 0.16;
    const offset = side.scale(halfWidth * profile * widthBias);
    const mix = 0.34 + t * 0.46;
    const light = brightness * (0.94 + t * 0.06);
    const red = (palette[0].r + (palette[1].r - palette[0].r) * mix) * light;
    const green = (palette[0].g + (palette[1].g - palette[0].g) * mix) * light;
    const blue = (palette[0].b + (palette[1].b - palette[0].b) * mix) * light;
    const left = center.subtract(offset);
    const right = center.add(offset);
    positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
    colors.push(red, green, blue, 1, red, green, blue, 1);
  }

  for (let segment = 0; segment < segments; segment++) {
    const left = vertexStart + segment * 2;
    indices.push(left, left + 2, left + 1, left + 1, left + 2, left + 3);
  }
}

/** Adds one small berry or floret as crossed quads, matching the leaf budget. */
function addAccent(
  positions: number[],
  indices: number[],
  colors: number[],
  center: Vector3,
  radius: number,
  palette: readonly [Color3, Color3],
  brightness: number,
): void {
  for (const across of [new Vector3(radius, 0, 0), new Vector3(0, 0, radius)]) {
    const up = new Vector3(0, radius, 0);
    const start = positions.length / 3;
    const corners = [
      center.subtract(across).subtract(up),
      center.add(across).subtract(up),
      center.add(across).add(up),
      center.subtract(across).add(up),
    ];
    const shades = [0.74, 0.86, 1.06, 0.94];
    for (let corner = 0; corner < corners.length; corner++) {
      const mix = corner >= 2 ? 0.82 : 0.24;
      const light = brightness * shades[corner];
      positions.push(corners[corner].x, corners[corner].y, corners[corner].z);
      colors.push(
        Math.min(1, (palette[0].r + (palette[1].r - palette[0].r) * mix) * light),
        Math.min(1, (palette[0].g + (palette[1].g - palette[0].g) * mix) * light),
        Math.min(1, (palette[0].b + (palette[1].b - palette[0].b) * mix) * light),
        1,
      );
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
}
