import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { NullEngine, Scene, VertexBuffer } from "@babylonjs/core";

register("./ts-extension-resolver.mjs", import.meta.url);
const {
  createTallPlantModel,
  tallPlantArchetypeForVariant,
} = await import("../src/TallPlantImpostor.ts");

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

test("tall plants share varied procedural geometry between models and impostors", () => {
  const capture = source("TallPlantImpostor.ts");

  assert.match(capture, /const STEM_COUNT = 14/);
  assert.match(capture, /faces: IMPOSTOR_CUBE_FACES/);
  assert.match(capture, /rotationallySymmetric: false/);
  assert.match(capture, /export function createTallPlantModel/);
  assert.match(capture, /const stage = random\(\)/);
  assert.match(capture, /isSeed/);
  assert.match(capture, /isBud/);
  assert.match(capture, /const leafCount = 5 \+ Math\.floor\(random\(\) \* 5\)/);
  assert.match(capture, /BLOOM_PALETTES/);
  assert.match(capture, /function addDaisyPatch/);
  assert.match(capture, /DAISY_PETAL_PALETTES/);
  assert.match(capture, /function addUmbelStand/);
  assert.match(capture, /function addFloret/);
});

test("bloom palettes span more than one hue family", () => {
  const capture = source("TallPlantImpostor.ts");
  const start = capture.indexOf("const BLOOM_PALETTES");
  const blooms = capture.slice(start, capture.indexOf("];", start));
  const brights = [...blooms.matchAll(
    /new Color3\(([\d.]+), ([\d.]+), ([\d.]+)\)\],/g,
  )].map(([, r, g, b]) => [Number(r), Number(g), Number(b)]);
  assert.ok(brights.length >= 8);
  // Warm yellows, reds and cool blues must all be represented, or every
  // meadow in the world ends up the same shade of pink.
  assert.ok(brights.some(([r, g, b]) => r > 0.9 && g > 0.8 && b < 0.6));
  assert.ok(brights.some(([r, g, b]) => r > 0.9 && g < 0.6 && b < 0.6));
  assert.ok(brights.some(([r, , b]) => b > r + 0.25));
});

test("the umbel archetype stays grounded inside its capture height", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const umbels = createTallPlantModel(scene, 1.75, 24680, 2);
  const positions = umbels.getVerticesData(VertexBuffer.PositionKind);
  assert.ok(positions && positions.length > 5_000);
  const heights = positions.filter((_, index) => index % 3 === 1);
  assert.ok(Math.min(...heights) >= -1e-6);
  assert.ok(Math.max(...heights) <= 1.75 + 1e-6);

  // Umbels carry their mass in a flat plate on top of bare stems. A spire
  // spreads blossom and foliage down its whole length, so comparing the two
  // keeps the check meaningful without pinning an arbitrary ratio.
  const spires = createTallPlantModel(scene, 1.75, 24680, 0);
  const spireHeights = spires.getVerticesData(VertexBuffer.PositionKind)
    .filter((_, index) => index % 3 === 1);
  const crownShare = (values) => {
    const ceiling = Math.max(...values) * 0.55;
    return values.filter((height) => height > ceiling).length / values.length;
  };
  assert.ok(crownShare(heights) > crownShare(spireHeights) + 0.15);
  scene.dispose();
  engine.dispose();
});

test("the former daisy impostor is a short alternate tall-plant variant", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map(tallPlantArchetypeForVariant),
    ["floweringSpire", "daisyPatch", "umbelHead", "floweringSpire"],
  );
  // The impostor path passes the signed seed, the model path its unsigned twin.
  assert.equal(tallPlantArchetypeForVariant(-1), tallPlantArchetypeForVariant(0xffffffff));

  const engine = new NullEngine();
  const scene = new Scene(engine);
  const daisies = createTallPlantModel(scene, 1.75, 54321, 1);
  const positions = daisies.getVerticesData(VertexBuffer.PositionKind);
  assert.ok(positions && positions.length > 5_000);
  const heights = positions.filter((_, index) => index % 3 === 1);
  assert.ok(Math.min(...heights) >= -1e-6);
  assert.ok(Math.max(...heights) < 0.8);
  scene.dispose();
  engine.dispose();
});

test("generated clumps are deterministic, grounded, and stay inside their capture height", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const first = createTallPlantModel(scene, 1.75, 12345);
  const second = createTallPlantModel(scene, 1.75, 12345);
  const firstPositions = first.getVerticesData(VertexBuffer.PositionKind);
  const secondPositions = second.getVerticesData(VertexBuffer.PositionKind);
  const colors = first.getVerticesData(VertexBuffer.ColorKind);

  assert.ok(firstPositions && firstPositions.length > 3_000);
  assert.deepEqual(firstPositions, secondPositions);
  assert.equal(colors?.length, firstPositions.length / 3 * 4);
  const heights = firstPositions.filter((_, index) => index % 3 === 1);
  assert.ok(Math.min(...heights) >= -1e-6);
  assert.ok(Math.max(...heights) <= 1.75 + 1e-6);

  scene.dispose();
  engine.dispose();
});

test("tall plants form sizeable irregular colonies on plausible land cover", () => {
  const field = source("TallPlantField.ts");

  assert.match(field, /const COLONY_SPACING_METERS = 9\.25/);
  assert.match(field, /const COLONY_MIN_COUNT = 7/);
  assert.match(field, /const COLONY_MAX_COUNT = 14/);
  assert.match(field, /const COLONY_RADIUS_METERS = 6\.2/);
  assert.match(field, /member \* 2\.399963229728653/);
  assert.match(field, /Math\.sqrt\(\(member \+ random\(\)\) \/ colonyCount\)/);
  assert.match(field, /habitatField\("tallPlants", modelVariantSeed, HABITAT\)/);
  assert.match(field, /if \(colonyStrength <= 0\) continue/);
  // The rarest layer, and the most uneven where it does appear.
  assert.match(field, /barrenShare: 0\.45/);
  assert.match(field, /const SPECIES_VARIANTS = 3/);
  assert.match(field, /^\s+SPECIES_VARIANTS,$/m);
  for (const cover of ["Grassland", "Wetland", "Shrubland"]) {
    assert.match(field, new RegExp(`LandCoverClass\\.${cover}`));
  }
  assert.doesNotMatch(field, /LandCoverClass\.(BuiltUp|Bare|SnowAndIce|Water)/);
});

test("tall plant colonies use regional variants, wind, exclusions, and model LOD", () => {
  const field = source("TallPlantField.ts");
  const game = source("Game.ts");

  assert.match(field, /"tallPlants"/);
  assert.match(field, /modelVariantSeed/);
  assert.match(field, /bucket\.variant\.seed/);
  assert.match(field, /bucket\.variant\.variantIndex/);
  assert.match(field, /exclusionMask\?\.intersects/);
  assert.match(field, /isTerrainFootprintAbove/);
  assert.match(field, /setVegetationWindShear\(\[plants, plantModel\]/);
  assert.match(field, /\[plants\],\s*\[plantModel\],\s*await packInstanceMatrices/);
  assert.match(game, /createTallPlantField/);
  assert.match(game, /"tallPlantField"/);
  assert.match(game, /tallPlantField\?: VegetationFieldResult/);
  assert.doesNotMatch(game, /FlowerField|flowerField/);
});
