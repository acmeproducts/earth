import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./ts-extension-resolver.mjs", import.meta.url);

const {
  PROCEDURAL_ACTOR_FAMILIES,
  proceduralActorMixAtTile,
} = await import("../src/ProceduralActorMix.ts");

const tile = (x, y) => ({ level: 16, x, y });

test("actor ratios are normalized and deterministic for a tile ID", () => {
  const first = proceduralActorMixAtTile(tile(34_702, 19_311), 12345);
  assert.deepEqual(first, proceduralActorMixAtTile(tile(34_702, 19_311), 12345));
  const ratioTotal = PROCEDURAL_ACTOR_FAMILIES.reduce(
    (sum, family) => sum + first[family].ratio,
    0,
  );
  const scaleTotal = PROCEDURAL_ACTOR_FAMILIES.reduce(
    (sum, family) => sum + first[family].densityScale,
    0,
  );
  assert.ok(Math.abs(ratioTotal - 1) < 1e-12);
  assert.ok(Math.abs(scaleTotal - PROCEDURAL_ACTOR_FAMILIES.length) < 1e-12);
  assert.ok(PROCEDURAL_ACTOR_FAMILIES.every((family) => first[family].ratio > 0));
});

test("neighboring tiles have smoothly varying actor compositions", () => {
  const first = proceduralActorMixAtTile(tile(34_702, 19_311), 12345);
  const neighbor = proceduralActorMixAtTile(tile(34_703, 19_311), 12345);
  assert.ok(PROCEDURAL_ACTOR_FAMILIES.every(
    (family) => Math.abs(first[family].ratio - neighbor[family].ratio) < 0.04,
  ));
  assert.ok(PROCEDURAL_ACTOR_FAMILIES.some(
    (family) => first[family].ratio !== neighbor[family].ratio,
  ));
});

test("the world seed changes the simplex actor fields", () => {
  const first = proceduralActorMixAtTile(tile(34_702, 19_311), 12345);
  const anotherWorld = proceduralActorMixAtTile(tile(34_702, 19_311), 54321);
  assert.notDeepEqual(first, anotherWorld);
});

test("actor composition wraps continuously at the antimeridian", () => {
  const west = proceduralActorMixAtTile(tile(0, 19_311), 12345);
  const east = proceduralActorMixAtTile(tile(2 ** 16, 19_311), 12345);
  assert.deepEqual(west, east);
});
