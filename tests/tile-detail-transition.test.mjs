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

test("keeps far building massing visible through the native terrain upgrade", () => {
  assert.match(game, /const carriedFarBuildings = previous\?\.farBuildings;/);
  assert.match(game, /farBuildings: carriedFarBuildings,/);
  assert.match(
    game,
    /record\.mapFeatures = mapFeatures\.root;[\s\S]*?record\.farBuildings = undefined;[\s\S]*?setMapLayerFade\(farBuildings, fade\)/,
  );
});

test("prebuilds both distant stand-ins before demoting tile detail", () => {
  assert.match(game, /record\.farTreeField && record\.farBuildings/);
  assert.match(game, /\(!record\.farTreeField \|\| !record\.farBuildings\)/);
  assert.match(
    game,
    /const farBuildings = record\.farBuildings;[\s\S]*?farBuildings\.setEnabled\(true\);[\s\S]*?setMapLayerFade\(farBuildings, fade\)/,
  );
});

test("cross-fades the retained impostors only when detailed trees commit", () => {
  assert.match(
    game,
    /if \(kind === "treeField" && record\.farTreeField\) \{[\s\S]*?this\.fadeFieldOutAndDispose\(farTrees\);/,
  );
});
