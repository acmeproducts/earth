import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import ts from "typescript";
import { groundCoverUnderSnow, snowCoverAt, snowCoverTier, treeSeasonAt } from "../src/vegetation/TreeSeason.ts";

const hook = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) return {
      format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }),
    };
    return nextLoad(url, context);
  },
});
const { NullEngine, Scene, Mesh, VertexBuffer } = await import("@babylonjs/core");
const { applyDefaultTerrainMaterial, setTerrainSnowCover, terrainSnowCover } =
  await import("../src/terrain/TerrainMesh.ts");
const { meshSnowCover } = await import("../src/rendering/SnowCover.ts");
hook.deregister();

// Exercise date refresh without constructing the browser-only Game shell.
const gameSource = readFileSync(new URL("../src/app/Game.ts", import.meta.url), "utf8");
const parsedGame = ts.createSourceFile("Game.ts", gameSource, ts.ScriptTarget.Latest, true);
const refreshMethod = parsedGame.statements.find(ts.isClassDeclaration).members
  .find((member) => member.name?.getText(parsedGame) === "refreshSeasonalScenery");
const { outputText } = ts.transpileModule(`class Subject { ${refreshMethod.getText(parsedGame)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
});
const SeasonSubject = new Function(
  "treeSeasonAt", "snowCoverTier", "groundCoverUnderSnow", "terrainSnowCover", "setTerrainSnowCover",
  "setHierarchySnowCover", outputText + "; return Subject;",
)(treeSeasonAt, snowCoverTier, groundCoverUnderSnow, terrainSnowCover, setTerrainSnowCover,
  () => { throw new Error("Unexpected map layer"); });

for (const reverse of [false, true]) {
  test(`date changes ${reverse ? "restore" : "reduce"} ground cover within one snow atlas tier`, () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const dates = [new Date(2026, 11, 1), new Date(2026, 11, 12)];
      if (reverse) dates.reverse();
      const [previousDate, nextDate] = dates;
      const oldDepth = snowCoverAt(previousDate, 60);
      const newDepth = snowCoverAt(nextDate, 60);
      assert.equal(snowCoverTier(oldDepth), snowCoverTier(newDepth));
      assert.notEqual(groundCoverUnderSnow(oldDepth), groundCoverUnderSnow(newDepth));
      const terrain = new Mesh("seasonal ground", scene);
      terrain.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0]);
      terrain.metadata = { snowCover: oldDepth, metersPerUnit: 1 };
      applyDefaultTerrainMaterial(scene, terrain);
      const subject = new SeasonSubject();
      subject.vegetationDate = previousDate;
      subject.solarLighting = { currentDate: nextDate };
      subject.tiles = new Map([["tile", { terrain, terrainData: {} }]]);
      subject.tileSnowCover = () => snowCoverAt(subject.vegetationDate, 60);
      let rebuilds = 0;
      subject.invalidateScenery = () => { rebuilds++; };

      subject.refreshSeasonalScenery();
      assert.equal(rebuilds, 1);
      assert.equal(terrainSnowCover(terrain), newDepth);
      subject.refreshSeasonalScenery();
      assert.equal(rebuilds, 1, "the next frame must not restart the pending rebuild");
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });
}

test("unchanged calendar days do not resample terrain or revisit scenery", () => {
  const subject = new SeasonSubject();
  subject.vegetationDate = new Date(2026, 11, 1, 1);
  subject.solarLighting = { currentDate: new Date(2026, 11, 1, 23) };
  subject.tiles = new Map([["tile", { terrainData: {} }]]);
  subject.tileSnowCover = () => { throw new Error("Unchanged date sampled terrain"); };
  subject.invalidateScenery = () => { throw new Error("Unchanged date rebuilt scenery"); };
  subject.refreshSeasonalScenery();
});

test("date changes refresh autumn stages without rebuilding within a shared stage", () => {
  const subject = new SeasonSubject();
  subject.vegetationDate = new Date(2026, 8, 1);
  subject.tiles = new Map();
  let rebuilds = 0;
  subject.invalidateScenery = () => { rebuilds++; };
  for (const [month, day, expected] of [[8, 10, 0], [8, 15, 1], [9, 1, 2], [9, 20, 2], [9, 21, 3], [10, 1, 4]]) {
    subject.solarLighting = { currentDate: new Date(2026, month, day) };
    subject.refreshSeasonalScenery();
    assert.equal(rebuilds, expected);
  }
});

test("live seasons change ground snow depth in place without swapping materials or colors", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const terrain = new Mesh("seasonal ground", scene);
    terrain.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0]);
    const skirt = new Mesh("seasonal ground skirt", scene);
    const colors = new Float32Array([0.2, 0.6, 0.1, 1]);
    terrain.metadata = { surfaceColors: colors, skirt, snowCover: 0, metersPerUnit: 2 };
    applyDefaultTerrainMaterial(scene, terrain);
    const summerMaterial = terrain.material;
    assert.equal(meshSnowCover(terrain), 0);

    setTerrainSnowCover(terrain, 0.7);
    assert.equal(terrainSnowCover(terrain), 0.7);
    assert.equal(meshSnowCover(terrain), 0.7);
    assert.equal(meshSnowCover(skirt), 0.7);
    // Land cover stays underneath: thin snow lets it show through in the shader.
    assert.equal(terrain.material, summerMaterial);
    assert.equal(terrain.useVertexColors, true);
    assert.deepEqual(terrain.getVerticesData(VertexBuffer.ColorKind), colors);
    assert.equal(terrain.isDisposed(), false);

    setTerrainSnowCover(terrain, 0);
    assert.equal(terrain.material, summerMaterial);
    assert.equal(meshSnowCover(terrain), 0);
    assert.equal(meshSnowCover(skirt), 0);
    assert.equal(terrainSnowCover(terrain), 0);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

test("a tile created with snow registers its depth with the shared material plugin", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const terrain = new Mesh("winter ground", scene);
    terrain.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0]);
    terrain.metadata = { snowCover: 0.4, metersPerUnit: 1 };
    applyDefaultTerrainMaterial(scene, terrain);
    assert.equal(meshSnowCover(terrain), 0.4);
    assert.ok(terrain.material.pluginManager?.getPlugin("SnowCover"));
    assert.equal(terrain.useVertexColors, false);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
