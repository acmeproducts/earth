import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { hasWinterGroundCover } = await import("../src/vegetation/TreeSeason.ts");

test("winter ground cover follows the hemisphere", () => {
  assert.equal(hasWinterGroundCover(new Date(2026, 0, 15), 60), true);
  assert.equal(hasWinterGroundCover(new Date(2026, 0, 15), -60), false);
  assert.equal(hasWinterGroundCover(new Date(2026, 6, 15), 60), false);
  assert.equal(hasWinterGroundCover(new Date(2026, 6, 15), -60), true);
});

test("tropical and invalid locations do not receive seasonal snow", () => {
  assert.equal(hasWinterGroundCover(new Date(2026, 0, 15), 10), false);
  assert.equal(hasWinterGroundCover(undefined, 60), false);
  assert.equal(hasWinterGroundCover(new Date(Number.NaN), 60), false);
});

test("winter ground cover suppresses seasonal low vegetation and rock patches", async () => {
  const game = await readFile(new URL("../src/app/Game.ts", import.meta.url), "utf8");

  const seasonalFields = [
    ["createGrassField", "grass"],
    ["createTallPlantField", "tallPlants"],
    ["createWheatField", "tallPlants"],
    ["createBushField", "bushes"],
    ["createFernField", "ferns"],
    ["createRockyBeachField", "rocks"],
  ];
  for (const [factory, layer] of seasonalFields) {
    assert.match(
      game,
      new RegExp(
        `${factory}\\(this\\.scene, terrainData, \\{[\\s\\S]*?` +
        `densityScale: \\(\\) => winterGroundCover \\? 0 : actorMix\\.${layer}\\.densityScale`,
      ),
    );
  }
});
