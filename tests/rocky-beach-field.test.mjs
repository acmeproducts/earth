import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const field = readFileSync(new URL("../src/RockyBeachField.ts", import.meta.url), "utf8");
const impostor = readFileSync(
  new URL("../src/RockyBeachImpostor.ts", import.meta.url),
  "utf8",
);
const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");

test("captures a dense procedural rocky-beach patch through the impostor pipeline", () => {
  assert.match(impostor, /createImpostorAssetProvider/);
  assert.match(impostor, /queryPrefix: "rocky-beach-impostor"/);
  assert.match(impostor, /STONE_COUNT = 112/);
  assert.match(impostor, /CreateIcoSphere/);
  assert.match(impostor, /createVertexColorCaptureMaterial/);
  assert.match(impostor, /upperHemisphereOnly: true/);
});

test("selects coherent natural shoreline stretches for rocky beaches", () => {
  assert.match(field, /rockyBeachCharacter\(location\.lon, location\.lat/);
  assert.match(field, /cover === LandCoverClass\.Bare/);
  assert.match(field, /waterNeighbours === 0/);
  assert.match(field, /threshold = mappedRockySurface \? 0\.3 : 0\.72/);
  assert.match(field, /isTerrainFootprintAbove/);
  assert.match(field, /normal\.y < 0\.78/);
});

test("streams rocky-beach impostors as a normal detailed field", () => {
  assert.match(game, /createRockyBeachField\(this\.scene, terrainData/);
  assert.match(game, /"rockyBeachField"/);
  assert.match(game, /record,\s+"rockyBeachField",\s+rockyBeachField/);
  assert.match(game, /rockyBeachField\.count} rocky beach patches/);
});
