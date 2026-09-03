import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { treeSeasonAt } = await import("../src/TreeSeason.ts");

test("temperate deciduous seasons follow the calendar and hemisphere", () => {
  const august = new Date(2026, 7, 23);
  const northern = treeSeasonAt(august, 59, "birch");
  const southern = treeSeasonAt(august, -41, "birch");

  assert.equal(northern.season, "summer");
  assert.equal(northern.leafCoverage, 1);
  assert.equal(southern.season, "winter");
  assert.ok(southern.leafCoverage < 0.1);
});

test("autumn colors and spring crown density are baked per species", () => {
  const autumnMaple = treeSeasonAt(new Date(2026, 9, 1), 52, "maple");
  const springOak = treeSeasonAt(new Date(2026, 3, 1), 52, "oak");

  assert.equal(autumnMaple.season, "autumn");
  assert.ok(autumnMaple.foliageTint[0] > 1.4);
  assert.ok(autumnMaple.foliageTint[1] < 0.7);
  assert.equal(springOak.season, "spring");
  assert.ok(springOak.leafCoverage > 0.5 && springOak.leafCoverage < 0.7);
});

test("tropical and evergreen trees retain their crowns", () => {
  const tropicalOak = treeSeasonAt(new Date(2026, 0, 15), 8, "oak");
  const winterPine = treeSeasonAt(new Date(2026, 0, 15), 60, "pine");

  assert.equal(tropicalOak.key, "tropical");
  assert.equal(tropicalOak.leafCoverage, 1);
  assert.equal(winterPine.season, "winter");
  assert.equal(winterPine.leafCoverage, 1);
});

test("tree models and impostors receive one shared seasonal variant", () => {
  const field = readFileSync(new URL("../src/TreeField.ts", import.meta.url), "utf8");
  const impostor = readFileSync(new URL("../src/TreeImpostor.ts", import.meta.url), "utf8");

  assert.match(field, /key: `\$\{region\.key\}\/local\/\$\{localVariant\}\/season\/\$\{season\.key\}`/);
  assert.match(field, /createTreeModels\([\s\S]*?variant\.season/);
  assert.match(impostor, /season: treeVariant\.season/);
});
