import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const worldCover = readFileSync(new URL("../src/world/WorldCover.ts", import.meta.url), "utf8");

test("LCM-10 is the sole land-cover source", () => {
  assert.match(worldCover, /new WorldCover\(await fetchLcm10\(bounds\)\)/);
  assert.doesNotMatch(worldCover, /arcgis|lerc|static source|loadDecoder/i);
  const dependencies = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies;
  assert.equal(dependencies.lerc, undefined);
});
