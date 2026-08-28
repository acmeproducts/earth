import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");

test("keeps far-tree impostors visible through the native terrain upgrade", () => {
  assert.match(
    game,
    /const carriedFarTreeField = previous\?\.farTreeField;[\s\S]*?if \(previous\) \{[\s\S]*?previous\.farTreeField = undefined;/,
  );
  assert.match(game, /farTreeField: carriedFarTreeField,/);
});

test("applies the mapped vegetation exclusions to distant trees", () => {
  const farTreeBuild = game.slice(
    game.indexOf("private async buildFarTrees"),
    game.indexOf("private async buildFarBuildings"),
  );
  assert.match(farTreeBuild, /OpenStreetMap\.createVegetationExclusionMask\(/);
  assert.match(farTreeBuild, /createTreeField[\s\S]*?exclusionMask,/);
});

test("keeps far building massing visible through the native terrain upgrade", () => {
  assert.match(game, /const carriedFarBuildings = previous\?\.farBuildings;/);
  assert.match(game, /farBuildings: carriedFarBuildings,/);
  assert.match(
    game,
    /record\.mapFeatures = mapFeatures\.root;[\s\S]*?record\.farBuildings = undefined;[\s\S]*?setMapLayerFade\(farBuildings, fade\)/,
  );
});

test("keeps far roads visible through native upgrades and detail transitions", () => {
  assert.match(game, /const carriedFarRoads = previous\?\.farRoads;/);
  assert.match(game, /farRoads: carriedFarRoads,/);
  assert.match(
    game,
    /record\.mapFeatures = mapFeatures\.root;[\s\S]*?record\.farRoads = undefined;[\s\S]*?setMapLayerFade\(farRoads, fade\)/,
  );
  assert.match(
    game,
    /const farRoads = record\.farRoads;[\s\S]*?farRoads\.setEnabled\(true\);[\s\S]*?setMapLayerFade\(farRoads, fade\)/,
  );
});

test("prebuilds every distant stand-in before demoting tile detail", () => {
  assert.match(game, /record\.farTreeField && record\.farBuildings && record\.farRoads/);
  assert.match(game, /\(!record\.farTreeField \|\| !record\.farBuildings \|\| !record\.farRoads\)/);
  assert.match(
    game,
    /const farBuildings = record\.farBuildings;[\s\S]*?farBuildings\.setEnabled\(true\);[\s\S]*?setMapLayerFade\(farBuildings, fade\)/,
  );
});

test("cross-fades all detailed vegetation with the retained tree impostors", () => {
  assert.match(
    game,
    /this\.stageTileField\(record, "fernField", fernField, generation\)[\s\S]*?this\.activateTileVegetation\(record\);/,
  );
  assert.match(
    game,
    /private activateTileVegetation[\s\S]*?this\.layerFades\.begin\(0, 1, \(fade\) => \{[\s\S]*?field\.setFade\(fade\);[\s\S]*?farTrees\.setFade\(1 - fade\);/,
  );
});
