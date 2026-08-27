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
});

test("the former daisy impostor is a short alternate tall-plant variant", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map(tallPlantArchetypeForVariant),
    ["floweringSpire", "daisyPatch", "floweringSpire", "floweringSpire"],
  );

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
