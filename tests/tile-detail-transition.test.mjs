import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const game = readFileSync(new URL("../src/Game.ts", import.meta.url), "utf8");

test("keeps far-tree impostors visible through the native terrain upgrade", () => {
  assert.match(
    game,
    /const carriedFarTreeField = previous\?\.farTreeField;\s+if \(previous\) previous\.farTreeField = undefined;/,
  );
  assert.match(game, /farTreeField: carriedFarTreeField,/);
});

test("cross-fades the retained impostors only when detailed trees commit", () => {
  assert.match(
    game,
    /if \(kind === "treeField" && record\.farTreeField\) \{[\s\S]*?this\.fadeFieldOutAndDispose\(farTrees\);/,
  );
});
