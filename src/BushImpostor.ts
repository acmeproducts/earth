import { Color3, Mesh, Scene, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
import {
  createVertexColorCaptureMaterial,
  setVertexColorModelHeight,
} from "./procedural/ProceduralCaptureMaterial";
import {
  createImpostorAssetProvider,
  IMPOSTOR_CUBE_FACES,
  type ImpostorAssetLease,
  type ImpostorVariant,
} from "./Impostor";
import { createSeededRandom } from "./Random";
import { bakeTreeExposure } from "./DirectionalExposure";
import { TreeModelGeometryCache } from "./TreeModelGeometryCache";

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
  directionalExposure: true,
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
  const woodPositions: number[] = [];
  const woodIndices: number[] = [];
  const woodColors: number[] = [];
  const woodRandom = createSeededRandom(seed ^ 0x574f4f44);
  const branchSegments: Array<readonly [Vector3, Vector3]> = [];
  const addWood = (start: Vector3, end: Vector3, radius: number, tipRadius: number): void => {
    addBranch(woodPositions, woodIndices, woodColors, start, end, radius, tipRadius);
  };
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

  // A shrub grows from several basal stems, each bending out into the crown.
  // Keep wood in the same mesh so both the close model and atlas share it.
  const stemCount = 7 + Math.floor(woodRandom() * 4);
  for (let stem = 0; stem < stemCount; stem++) {
    const angle = crownRotation + stem / stemCount * Math.PI * 2
      + (woodRandom() - 0.5) * 0.42;
    const reach = radiusAtAngle(angle) * crownWidth * (0.5 + woodRandom() * 0.3);
    const root = new Vector3(Math.cos(angle) * 0.085, -SOURCE_HEIGHT / 2, Math.sin(angle) * 0.085);
    const fork = new Vector3(
      Math.cos(angle) * reach * 0.36 + crownLeanX * 0.4,
      -0.55 + woodRandom() * 0.2,
      Math.sin(angle) * reach * 0.36 + crownLeanZ * 0.4,
    );
    const tip = new Vector3(
      Math.cos(angle) * reach + crownLeanX,
      0.12 + woodRandom() * 0.44 * crownHeight,
      Math.sin(angle) * reach + crownLeanZ,
    );
    const thickness = 0.024 + woodRandom() * 0.016;
    addWood(root, fork, thickness, thickness * 0.65);
    addWood(fork, tip, thickness * 0.65, 0.006);
    branchSegments.push([root, fork], [fork, tip]);
  }

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
    const localBottom = -0.76 + normalizedRadius * 0.24 + (random() - 0.5) * 0.1;
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
    // Every leafy shoot joins the nearest woody stem, leaving a visible,
    // connected framework in the gaps between sprays.
    let attachment = branchSegments[0][0];
    let nearestDistance = Infinity;
    for (const [start, end] of branchSegments) {
      const axis = end.subtract(start);
      const along = Math.max(0, Math.min(1,
        Vector3.Dot(sprayStart.subtract(start), axis) / axis.lengthSquared()));
      const candidate = start.add(axis.scale(along));
      const distance = Vector3.DistanceSquared(candidate, sprayStart);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        attachment = candidate;
      }
    }
    addWood(attachment, sprayStart, 0.008 + woodRandom() * 0.004, 0.004);
    addWood(sprayStart, sprayEnd, 0.004, 0.0015);
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

  const foliageVertices = positions.length / 3;
  for (const value of woodPositions) positions.push(value);
  for (const value of woodIndices) indices.push(value + foliageVertices);
  for (const value of woodColors) colors.push(value);
  const data = new VertexData();
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.colors = colors;
  // UV.x = 2 marks bark for solid-surface lighting and opaque occlusion.
  const uvs = new Float32Array(positions.length / 3 * 2);
  for (let vertex = foliageVertices; vertex < positions.length / 3; vertex++) {
    uvs[vertex * 2] = 2;
  }
  data.uvs = uvs;

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

const bushModelCaches = new WeakMap<Scene, TreeModelGeometryCache>();

/** Builds the original procedural geometry with cached sunlight exposure at the requested height. */
export async function createBushModel(scene: Scene, renderHeight: number, seed?: number): Promise<Mesh> {
  let cache = bushModelCaches.get(scene);
  if (!cache) {
    cache = new TreeModelGeometryCache();
    bushModelCaches.set(scene, cache);
    scene.onDisposeObservable.addOnce(() => bushModelCaches.delete(scene));
  }
  const [bush] = await cache.create(String(seed ?? 0x42555348), scene, async () => {
    const source = createBushSource(scene, true, seed);
    source.isVisible = false;
    try {
      await bakeTreeExposure([source]);
    } catch (error) {
      const material = source.material;
      source.dispose(false, false);
      material?.dispose(true, false);
      throw error;
    }
    return [source];
  });
  const material = createVertexColorCaptureMaterial(scene, "bushModelMaterial", true);
  material.options.defines.push("#define TREE_EXPOSURE");
  material.options.attributes.push("sunExposureLow", "sunExposureHigh");
  bush.material = material;
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

/** A closed, tapered hexagonal stem with subtle longitudinal bark variation. */
function addBranch(
  positions: number[], indices: number[], colors: number[],
  start: Vector3, end: Vector3, radius: number, tipRadius: number,
): void {
  const axis = end.subtract(start);
  if (axis.lengthSquared() < 0.000001) return;
  axis.normalize();
  const reference = Math.abs(axis.y) < 0.9 ? Vector3.Up() : Vector3.Right();
  const side = Vector3.Cross(axis, reference).normalize();
  const across = Vector3.Cross(axis, side).normalize();
  const first = positions.length / 3;
  const sides = 6;
  for (let ring = 0; ring < 2; ring++) {
    const center = ring === 0 ? start : end;
    const width = ring === 0 ? radius : tipRadius;
    for (let corner = 0; corner < sides; corner++) {
      const angle = corner / sides * Math.PI * 2;
      const point = center.add(side.scale(Math.cos(angle) * width))
        .add(across.scale(Math.sin(angle) * width));
      positions.push(point.x, point.y, point.z);
      const shade = 0.84 + (corner % 3) * 0.09 + ring * 0.04;
      colors.push(0.25 * shade, 0.18 * shade, 0.11 * shade, 1);
    }
  }
  for (let corner = 0; corner < sides; corner++) {
    const next = (corner + 1) % sides;
    indices.push(first + corner, first + next, first + sides + corner,
      first + next, first + sides + next, first + sides + corner);
  }
  for (let corner = 1; corner < sides - 1; corner++) {
    indices.push(first, first + corner + 1, first + corner,
      first + sides, first + sides + corner, first + sides + corner + 1);
  }
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
