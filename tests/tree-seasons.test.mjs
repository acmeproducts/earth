import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { treeSeasonAt, autumnLeafTint } = await import("../src/TreeSeason.ts");

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

  assert.match(field, /key: `\$\{tileRegion\.key\}\/local\/\$\{tileLocalVariant\}\/season\/\$\{season\.key\}`/);
  assert.match(field, /createTreeModels\([\s\S]*?variant\.season/);
  assert.match(impostor, /season: treeVariant\.season/);
});

test("autumn crowns mix leaf colors and differ in maturity with stable cache identities", () => {
  const date = new Date(2026, 9, 1);
  const crowns = [0, 1, 2].map((variant) => treeSeasonAt(date, 52, "maple", variant));
  assert.equal(new Set(crowns.map((crown) => crown.key)).size, 3);
  const greenCounts = crowns.map((crown) => {
    const colors = Array.from({ length: 100 }, (_, index) => autumnLeafTint(crown, index / 100));
    assert.equal(new Set(colors.map((color) => color.join(","))).size, 3);
    return colors.filter((color) => color === crown.autumnPalette.tints[0]).length;
  });
  assert.ok(greenCounts[0] > greenCounts[1] && greenCounts[1] > greenCounts[2]);
  assert.ok(crowns[0].leafCoverage > crowns[2].leafCoverage);
  assert.deepEqual(treeSeasonAt(date, 52, "maple", 1), crowns[1]);
  assert.notDeepEqual(
    treeSeasonAt(date, 52, "birch").autumnPalette.tints[2],
    crowns[1].autumnPalette.tints[2],
  );
});

test("autumn variation leaves evergreen, tropical and other seasonal appearances alone", () => {
  for (const [date, latitude, species] of [
    [new Date(2026, 9, 1), 52, "pine"],
    [new Date(2026, 9, 1), 8, "oak"],
    [new Date(2026, 6, 1), 52, "oak"],
  ]) {
    const appearance = treeSeasonAt(date, latitude, species, 0);
    assert.deepEqual(appearance, treeSeasonAt(date, latitude, species, 2));
    assert.equal(appearance.autumnPalette, undefined);
    assert.deepEqual(autumnLeafTint(appearance, 0.5), appearance.foliageTint);
  }
});
