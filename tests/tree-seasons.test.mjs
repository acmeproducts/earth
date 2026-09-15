import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { treeSeasonAt, autumnLeafTint, autumnLeafSamples } = await import("../src/vegetation/TreeSeason.ts");

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
  const field = readFileSync(new URL("../src/vegetation/TreeField.ts", import.meta.url), "utf8");
  const impostor = readFileSync(new URL("../src/vegetation/TreeImpostor.ts", import.meta.url), "utf8");

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
    // A continuous ramp from green through gold to the mature color.
    assert.ok(new Set(colors.map((color) => color.join(","))).size >= 3);
    return colors.filter((color) => color === crown.autumnPalette.tints[0]).length;
  });
  assert.ok(greenCounts[0] > greenCounts[1] && greenCounts[1] > greenCounts[2]);
  // Later maturities push more of the crown toward red, and only the mature
  // crown reaches the species' final color.
  const warmth = crowns.map((crown) => {
    const colors = Array.from({ length: 100 }, (_, index) => autumnLeafTint(crown, index / 100));
    return colors.reduce((sum, color) => sum + color[0] - color[1], 0) / colors.length;
  });
  assert.ok(warmth[0] < warmth[1] && warmth[1] < warmth[2]);
  assert.deepEqual(autumnLeafTint(crowns[2], 1), crowns[2].autumnPalette.tints[2]);
  assert.notDeepEqual(autumnLeafTint(crowns[0], 1), crowns[0].autumnPalette.tints[2]);
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
    assert.deepEqual(autumnLeafTint(appearance, 0.5), [...appearance.foliageTint, 1]);
  }
});

test("autumn leaf colors form crown patterns instead of per-leaf noise", () => {
  // A shell of leaf cards around a spherical crown centered at (0, 2, 0).
  const count = 600;
  const cards = Array.from({ length: count }, (_, index) => {
    const t = (index + 0.5) / count;
    const y = 1 - 2 * t;
    const ring = Math.sqrt(1 - y * y);
    const angle = index * 2.399963;
    const shell = 0.6 + 0.4 * ((index * 7) % 10) / 10;
    return { x: ring * Math.cos(angle) * shell, y: 2 + y * shell, z: ring * Math.sin(angle) * shell };
  });
  const samples = autumnLeafSamples(cards, 1234);

  // Rank-normalized so the palette's maturity shares stay exact, and deterministic.
  assert.equal(samples.length, count);
  const sorted = [...samples].sort((a, b) => a - b);
  sorted.forEach((sample, rank) => assert.ok(Math.abs(sample - rank / count) < 1e-9));
  assert.deepEqual(autumnLeafSamples(cards, 1234), samples);
  assert.notDeepEqual(autumnLeafSamples(cards, 99), samples);

  // Neighboring leaves turn together: uncorrelated samples would differ by 1/3 on average.
  let neighborDifference = 0;
  for (let i = 0; i < count; i++) {
    let nearest = -1;
    let nearestDistance = Infinity;
    for (let j = 0; j < count; j++) {
      if (i === j) continue;
      const distance = Math.hypot(cards[i].x - cards[j].x, cards[i].y - cards[j].y, cards[i].z - cards[j].z);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = j;
      }
    }
    neighborDifference += Math.abs(samples[i] - samples[nearest]);
  }
  assert.ok(neighborDifference / count < 0.2, `neighbors differ by ${neighborDifference / count}`);

  // The sun-exposed top of the crown turns before the shaded bottom.
  const mean = (indices) => indices.reduce((sum, index) => sum + samples[index], 0) / indices.length;
  const byHeight = cards.map((_, index) => index).sort((a, b) => cards[a].y - cards[b].y);
  const quarter = count / 4;
  assert.ok(mean(byHeight.slice(-quarter)) > mean(byHeight.slice(0, quarter)) + 0.2);

  // Empty crowns and the palette mapping both stay well defined.
  assert.deepEqual(autumnLeafSamples([], 1), []);
  const crown = treeSeasonAt(new Date(2026, 9, 1), 52, "maple", 1);
  const colors = samples.map((sample) => autumnLeafTint(crown, sample));
  assert.ok(new Set(colors.map((color) => color.join(","))).size >= 3);
});

test("procedural foliage bakes the patterned autumn samples per leaf card", () => {
  const tree = readFileSync(new URL("../src/procedural/ProceduralTree.ts", import.meta.url), "utf8");
  assert.match(tree, /autumnLeafSamples\(cards\.map\(\(vertex\) => foliageCardCenter\(buffers, vertex\)\), seed\)/);
  assert.match(tree, /autumnLeafTint\(season, samples \? samples\[card\] : 0\)/);
});
