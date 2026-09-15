import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const game = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
const treeField = readFileSync(new URL("../src/vegetation/TreeField.ts", import.meta.url), "utf8");

test("keeps far-tree impostors visible through the native terrain upgrade", () => {
  assert.match(
    game,
    /const carriedFarTreeField = retainScenery \? previous\?\.farTreeField : undefined;[\s\S]*?if \(retainScenery\) \{[\s\S]*?previous\.farTreeField = undefined;/,
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

test("renders forced far-tree impostors with detailed dithered coverage", () => {
  const farTreeBuild = game.slice(
    game.indexOf("private async buildFarTrees"),
    game.indexOf("private async buildFarBuildings"),
  );
  assert.match(farTreeBuild, /forceLowestImpostorLod: true/);
  assert.match(treeField, /float lodBlend = max\(\s*forceLowestLod,/);
  assert.match(treeField, /float alpha = highColor\.a/);
  assert.doesNotMatch(
    treeField,
    /if \(forceLowestLod > 0\.5\)[\s\S]*?return lowColor/,
  );
});

test("keeps far building massing visible through the native terrain upgrade", () => {
  assert.match(game, /const carriedFarBuildings = retainScenery \? previous\?\.farBuildings : undefined;/);
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

test("cross-fades all detailed vegetation and aborts activation after a world change", async () => {
  // Execute the real method without constructing the browser-only Game shell.
  const parsed = ts.createSourceFile("Game.ts", game, ts.ScriptTarget.Latest, true);
  const method = parsed.statements.find(ts.isClassDeclaration).members
    .find((member) => member.name?.getText(parsed) === "activateTileVegetation");
  const { outputText } = ts.transpileModule(`class Subject { ${method.getText(parsed)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  const kinds = ["treeField", "saplingField", "grassField", "tallPlantField", "wheatField", "rockyBeachField", "bushField", "fernField"];
  const Subject = new Function("VEGETATION_FIELD_KINDS", outputText + "; return Subject;")(kinds);
  const field = () => ({ fades: [], enabled: false, disposed: false,
    setFade(value) { this.fades.push(value); },
    get root() { return { setEnabled: (value) => { this.enabled = value; },
      isDisposed: () => this.disposed, dispose: () => { this.disposed = true; } }; },
  });
  for (const cancel of [false, true]) {
    const subject = new Subject();
    const record = Object.fromEntries([...kinds, "rockField", "farTreeField"].map((kind) => [kind, field()]));
    record.terrain = { isDisposed: () => false };
    const farTrees = record.farTreeField;
    let frames = 0, fadeStarted = false;
    subject.streamingGeneration = 1;
    subject.streamingYielder = { nextFrame: async () => { frames++; if (cancel) subject.streamingGeneration++; } };
    subject.refreshShadowCasters = () => {};
    subject.updateVegetationLod = () => {};
    subject.layerFades = { begin: (from, to, update, finish) => {
      fadeStarted = true;
      assert.deepEqual([from, to], [0, 1]);
      update(0.25);
      for (const kind of [...kinds, "rockField"]) assert.deepEqual(record[kind].fades, [0, 0.25]);
      assert.deepEqual(farTrees.fades, [0.75]);
      finish();
    } };
    await subject.activateTileVegetation(record, 1);
    assert.equal(frames, cancel ? 1 : 9);
    assert.equal(fadeStarted, !cancel);
    assert.equal(farTrees.disposed, !cancel);
    if (cancel) assert.equal(record.saplingField.enabled, false);
    else assert.equal(record.farTreeField, undefined);
  }
});
